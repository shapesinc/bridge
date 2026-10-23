"use strict";

// This computer's side of "route the agent's browser through the person's own computer":
// it holds one outbound WebSocket to the shapes.inc relay and opens the TCP connections the agent's
// cloud browser asks for, from this computer's own network, so sites see the person's IP.
// It only ever sees the hostname and the encrypted bytes (TLS runs browser <-> site).
// A port of the relay's device.mjs (app repo, workers/device-relay/src/device.mjs), on Bridge's own
// WebSocket client instead of the `ws` package.
const dns = require("node:dns");
const net = require("node:net");
const { Mux } = require("./mux");
const { isPublicAddress, targetHost, WEB_PORTS } = require("./addresses");
const { connectWebSocket, OPEN } = require("./ws-client");

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_RETRY_MS = 30_000;
// The relay pings every 20 s; a connection silent for longer than this is gone (sleep, network change).
const IDLE_TIMEOUT_MS = 60_000;
// The relay closes with 4401 when it refuses (or stops accepting) the token.
const TOKEN_REFUSED = 4401;

/** A dns.lookup that only ever returns public addresses (Node then connects to nothing else). */
function publicLookup(resolve = dns.lookup) {
  return (hostname, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    if (typeof options === "number") options = { family: options };
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const usable = addresses.filter((entry) => isPublicAddress(entry.address));
      if (!usable.length) {
        const refused = new Error(`${hostname} resolves only to private or reserved addresses`);
        refused.code = "private_address";
        return callback(refused);
      }
      if (options?.all) return callback(null, usable);
      return callback(null, usable[0].address, usable[0].family);
    });
  };
}

const today = () => new Date().toDateString();

/**
 * Connects to the relay and serves its streams until stopped. Options:
 *   url, token: the relay's /device endpoint and this computer's relay token (from shapes.inc).
 *   ports: allowed destination ports (80 and 443).
 *   dailyBytes: stop serving past this many bytes in a day (the person's data cap).
 *   usage: {day, bytes} already used today (carried over a restart).
 *   allowPrivate: tests only, to reach a local origin.
 *   onActivity(event): {type: "open" | "close" | "refused" | "connected" | "offline", host?, reason?, bytes?}.
 *   onTokenRefused(): the relay refused the token (close code 4401, or HTTP 401 on connect). Instead of
 *     reconnecting with the same token, the device waits for update({token}) with a fresh one.
 *     Without it, the device stops reconnecting. A refused in-band token (see update) also closes with 4401.
 */
function startDevice({ url, token, ports = WEB_PORTS, dailyBytes = Infinity, usage: initialUsage, allowPrivate = false,
  lookup = dns.lookup, onActivity = () => {}, onTokenRefused, reconnect = true, connect: openSocket = connectWebSocket,
  retryMs = 1_000, idleTimeoutMs = IDLE_TIMEOUT_MS } = {}) {
  let socket;
  let socketUrl; // the relay the open socket went to
  let stopped = false;
  let paused = false;
  let waitingForToken = false;
  let retryTimer;
  let retry = retryMs;
  let live = 0; // connections open to sites right now
  let usage = initialUsage?.day === today() && Number.isFinite(initialUsage.bytes) ? { day: initialUsage.day, bytes: initialUsage.bytes } : { day: today(), bytes: 0 };
  const resolver = allowPrivate ? lookup : publicLookup(lookup);

  const count = (bytes) => {
    const day = today();
    if (usage.day !== day) usage = { day, bytes: 0 };
    usage.bytes += bytes;
  };

  const serve = (mux) => (id, rawHost, port) => {
    const host = targetHost(rawHost);
    const refuse = (reason) => {
      mux.refuse(id, reason);
      onActivity({ type: "refused", host: host ?? String(rawHost).slice(0, 80), reason });
    };
    if (paused) return refuse("paused");
    if (usage.day !== today()) usage = { day: today(), bytes: 0 };
    if (usage.bytes >= dailyBytes) return refuse("data_cap");
    if (!host) return refuse("bad_host");
    if (!ports.has(port)) return refuse("port");
    if (net.isIP(host) && !allowPrivate && !isPublicAddress(host)) return refuse("private_address");
    const stream = mux.accept(id);
    const tcp = net.connect({ host, port, lookup: resolver, autoSelectFamily: true, timeout: CONNECT_TIMEOUT_MS });
    let opened = false;
    tcp.once("connect", () => {
      opened = true;
      live++;
      tcp.setTimeout(0);
      mux.opened(id);
      onActivity({ type: "open", host });
    });
    tcp.once("timeout", () => tcp.destroy(Object.assign(new Error("timeout"), { code: "timeout" })));
    tcp.on("error", (error) => {
      if (!opened) {
        const reason = error.code === "private_address" ? "private_address" : error.code === "ENOTFOUND" ? "dns"
          : error.code === "timeout" ? "timeout" : "connect";
        refuse(reason);
      } else stream.destroy();
    });
    stream.on("error", () => tcp.destroy());
    tcp.on("close", () => {
      count(stream.bytesIn + stream.bytesOut);
      if (opened) {
        live--;
        onActivity({ type: "close", host, bytes: stream.bytesIn + stream.bytesOut });
      }
      if (!stream.destroyed && !stream.writableEnded) stream.end();
    });
    // Writes before the TCP connection is up queue in the socket (the relay may send the TLS hello at once).
    stream.pipe(tcp);
    tcp.pipe(stream);
  };

  const connect = () => {
    retryTimer = undefined;
    if (stopped) return;
    let current;
    try {
      current = openSocket(url, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeoutMs: 15_000, idleTimeoutMs });
    } catch {
      // Only a relay address that isn't wss:// gets here; retrying it can't help.
      stopped = true;
      onActivity({ type: "offline", reason: "bad_url" });
      return;
    }
    socket = current;
    socketUrl = url;
    const mux = new Mux((bytes) => current.readyState === OPEN && current.send(bytes));
    mux.onOpen = serve(mux);
    current.on("open", () => {
      retry = retryMs;
      onActivity({ type: "connected" });
    });
    current.on("message", (data, binary) => binary && mux.receive(data));
    current.on("close", (code) => {
      mux.close();
      if (socket !== current) return;
      socket = undefined;
      onActivity({ type: "offline", reason: String(code) });
      if (stopped || !reconnect) return;
      if (code === TOKEN_REFUSED || current.handshakeStatus === 401) {
        // Expired or revoked: ask shapes.inc for a new token rather than retrying this one.
        if (onTokenRefused) { waitingForToken = true; onTokenRefused(); }
        else stopped = true;
        return;
      }
      retry = Math.min(retry * 2, MAX_RETRY_MS);
      retryTimer = setTimeout(connect, retry + Math.floor(Math.random() * retryMs));
    });
    current.on("error", () => {});
  };
  connect();

  return {
    /** The kill switch: drops every open connection now and stops reconnecting. */
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      socket?.terminate();
    },
    /**
     * A fresh token (and relay address). While connected to that same relay, the token goes over the open
     * connection ({"type":"token"} text frame), so the relay extends it instead of closing it at the old
     * token's expiry; it's also kept for the next connection. Connects now if one was being waited for.
     */
    update(next = {}) {
      const fresh = next.token && next.token !== token;
      if (next.url) url = next.url;
      if (next.token) token = next.token;
      if (waitingForToken && !stopped) {
        waitingForToken = false;
        connect();
      } else if (fresh && socket?.readyState === OPEN && socketUrl === url) {
        socket.sendText(JSON.stringify({ type: "token", token }));
      }
    },
    pause() { paused = true; },
    resume() { paused = false; },
    get connected() { return socket?.readyState === OPEN; },
    get open() { return live; },
    get usage() { return usage.day === today() ? { ...usage } : { day: today(), bytes: 0 }; },
  };
}

module.exports = { startDevice, publicLookup, TOKEN_REFUSED };
