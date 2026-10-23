"use strict";

// A minimal RFC 6455 WebSocket client: just what this computer's one connection to the relay needs.
// Bridge has no runtime dependencies and Node 18 has no global WebSocket, so it is written here.
// Binary messages (and continuation frames), ping -> pong, close codes. No extensions, no
// subprotocols, frames up to 1 MiB. Client frames are masked; server frames must not be.
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const { EventEmitter } = require("node:events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD = 1024 * 1024;
const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CONTINUATION = 0x0, TEXT = 0x1, BINARY = 0x2, CLOSE = 0x8, PING = 0x9, PONG = 0xa;

/** The relay's address: wss:// only, except ws:// on this computer itself for development and tests. */
function relayUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("The relay address is not a valid URL."); }
  if (url.username || url.password || url.hash ||
      (url.protocol !== "wss:" && !(url.protocol === "ws:" && LOCAL_HOSTS.has(url.hostname)))) {
    throw new Error("The relay must use wss:// (ws:// is allowed only on localhost for development).");
  }
  return url;
}

// Mask keys come from the CSPRNG, a few KiB at a time.
const maskPool = Buffer.alloc(4096);
let maskOffset = maskPool.length;
function maskKey() {
  if (maskOffset + 4 > maskPool.length) { crypto.randomFillSync(maskPool); maskOffset = 0; }
  maskOffset += 4;
  return maskPool.subarray(maskOffset - 4, maskOffset);
}

/** One masked, final client frame. */
function encodeFrame(opcode, payload) {
  const length = payload.length;
  const extended = length > 0xffff ? 8 : length > 125 ? 2 : 0;
  const start = 2 + extended + 4;
  const bytes = Buffer.allocUnsafe(start + length);
  bytes[0] = 0x80 | opcode;
  if (extended === 8) {
    bytes[1] = 0x80 | 127;
    bytes.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
    bytes.writeUInt32BE(length >>> 0, 6);
  } else if (extended === 2) {
    bytes[1] = 0x80 | 126;
    bytes.writeUInt16BE(length, 2);
  } else bytes[1] = 0x80 | length;
  const mask = maskKey();
  mask.copy(bytes, start - 4);
  for (let i = 0; i < length; i++) bytes[start + i] = payload[i] ^ mask[i & 3];
  return bytes;
}

const validCloseCode = (code) => (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);

/**
 * Events: "open"; "message" (data: Buffer, binary: boolean); "error" (error); "close" (code, reason).
 * `handshakeStatus` holds the HTTP status when the relay answered the upgrade with something else
 * (401 means it refused the token). The close code is 1006 when the connection ended without a close frame.
 */
class WebSocketClient extends EventEmitter {
  constructor(url, { headers = {}, handshakeTimeoutMs = 15_000, idleTimeoutMs = 0, maxPayload = MAX_PAYLOAD } = {}) {
    super();
    this.readyState = CONNECTING;
    this.handshakeStatus = undefined;
    this.closeCode = 1006;
    this.closeReason = "";
    this.maxPayload = maxPayload;
    this.idleTimeoutMs = idleTimeoutMs;
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.done = false; // a close frame or a protocol error: nothing more is read
    this.socket = null;
    const target = relayUrl(url);
    const secure = target.protocol === "wss:";
    const key = crypto.randomBytes(16).toString("base64");
    this.request = (secure ? https : http).request({
      hostname: target.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: "GET",
      agent: false,
      headers: { ...headers, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key },
    });
    this.handshakeTimer = setTimeout(() => this.fail(new Error("The relay did not answer in time.")), handshakeTimeoutMs);
    this.request.on("error", (error) => this.fail(error));
    this.request.on("response", (response) => {
      response.resume();
      this.handshakeStatus = response.statusCode;
      this.fail(Object.assign(new Error(`The relay answered HTTP ${response.statusCode}.`), { status: response.statusCode }));
    });
    this.request.on("upgrade", (response, socket, head) => {
      const expected = crypto.createHash("sha1").update(key + GUID).digest("base64");
      const headers = response.headers;
      if (String(headers.upgrade).toLowerCase() !== "websocket" || !/(^|,)\s*upgrade\s*(,|$)/i.test(headers.connection || "") ||
          headers["sec-websocket-accept"] !== expected || headers["sec-websocket-extensions"] || headers["sec-websocket-protocol"]) {
        socket.destroy();
        this.fail(new Error("The relay's WebSocket handshake was invalid."));
        return;
      }
      if (this.readyState !== CONNECTING) { socket.destroy(); return; }
      clearTimeout(this.handshakeTimer);
      this.socket = socket;
      this.readyState = OPEN;
      socket.setNoDelay(true);
      socket.setTimeout(0);
      socket.on("data", (chunk) => this.onData(chunk));
      socket.on("error", (error) => this.emitError(error));
      socket.on("close", () => this.finish());
      if (idleTimeoutMs > 0) {
        // The relay pings every 20 s: silence for longer than this means the network is gone (sleep, Wi-Fi change).
        this.idleTimer = setTimeout(() => this.terminate(), idleTimeoutMs);
      }
      this.emit("open");
      if (head?.length) this.onData(head);
    });
    this.request.end();
  }

  /** Sends one binary message. */
  send(data) {
    if (this.readyState !== OPEN) return false;
    return this.socket.write(encodeFrame(BINARY, data));
  }

  /** Starts the closing handshake; the socket is dropped if the relay doesn't answer within 5 s. */
  close(code = 1000, reason = "") {
    if (this.readyState === CONNECTING) return this.terminate();
    if (this.readyState !== OPEN) return;
    this.readyState = CLOSING;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.socket.write(encodeFrame(CLOSE, payload.subarray(0, 125)));
    this.closeTimer = setTimeout(() => this.socket.destroy(), 5000);
  }

  /** Drops the connection now, without a closing handshake. */
  terminate() {
    if (this.readyState === CLOSED) return;
    if (this.socket) this.socket.destroy();
    else { this.request.destroy(); this.finish(); }
  }

  fail(error) {
    if (this.readyState === CLOSED || this.socket) return;
    this.request.destroy();
    this.emitError(error);
    this.finish();
  }

  emitError(error) {
    if (this.listenerCount("error")) this.emit("error", error);
  }

  finish() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.closeTimer);
    this.emit("close", this.closeCode, this.closeReason);
  }

  /** A protocol error from the relay: say why (1002, or 1009 for too big) and drop the connection. */
  protocolError(code, message) {
    this.emitError(new Error(message));
    if (this.readyState === OPEN) {
      const payload = Buffer.allocUnsafe(2);
      payload.writeUInt16BE(code, 0);
      this.socket.end(encodeFrame(CLOSE, payload));
    }
    this.readyState = CLOSING;
    this.done = true;
    this.buffer = Buffer.alloc(0);
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.socket.destroy(), 1000);
  }

  onData(chunk) {
    if (this.readyState === CLOSED || this.done) return;
    this.idleTimer?.refresh();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 2 && !this.done) {
      const buffer = this.buffer;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      if (buffer[0] & 0x70) return this.protocolError(1002, "The relay used a WebSocket extension that was not negotiated.");
      if (buffer[1] & 0x80) return this.protocolError(1002, "The relay sent a masked frame.");
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        if (buffer.readUInt32BE(2) !== 0) return this.protocolError(1009, "The relay sent a frame that is too big.");
        length = buffer.readUInt32BE(6);
        offset = 10;
      }
      if (length > this.maxPayload) return this.protocolError(1009, "The relay sent a frame that is too big.");
      if (opcode >= 0x8 && (!fin || length > 125)) return this.protocolError(1002, "The relay sent an invalid control frame.");
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      this.buffer = buffer.subarray(offset + length);
      this.onFrame(fin, opcode, payload);
    }
  }

  onFrame(fin, opcode, payload) {
    if (opcode === TEXT || opcode === BINARY) {
      if (this.fragments) return this.protocolError(1002, "The relay started a new message inside a fragmented one.");
      if (fin) {
        if (this.readyState === OPEN) this.emit("message", payload, opcode === BINARY);
        return;
      }
      this.fragments = { binary: opcode === BINARY, parts: [payload], length: payload.length };
      return;
    }
    if (opcode === CONTINUATION) {
      if (!this.fragments) return this.protocolError(1002, "The relay sent a continuation frame without a message.");
      this.fragments.parts.push(payload);
      this.fragments.length += payload.length;
      if (this.fragments.length > this.maxPayload) return this.protocolError(1009, "The relay sent a message that is too big.");
      if (fin) {
        const { binary, parts } = this.fragments;
        this.fragments = null;
        if (this.readyState === OPEN) this.emit("message", Buffer.concat(parts), binary);
      }
      return;
    }
    if (opcode === PING) {
      if (this.readyState === OPEN) this.socket.write(encodeFrame(PONG, payload));
      return;
    }
    if (opcode === PONG) return;
    if (opcode === CLOSE) {
      if (payload.length === 1) return this.protocolError(1002, "The relay sent an invalid close frame.");
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      if (payload.length >= 2 && !validCloseCode(code)) return this.protocolError(1002, "The relay sent an invalid close code.");
      this.done = true;
      this.closeCode = code;
      this.closeReason = payload.subarray(2).toString("utf8");
      if (this.readyState === OPEN) {
        // Echo the code back, then let the relay close the TCP connection.
        this.socket.end(encodeFrame(CLOSE, payload.subarray(0, 2)));
      } else this.socket.end();
      this.readyState = CLOSING;
      clearTimeout(this.closeTimer);
      this.closeTimer = setTimeout(() => this.socket.destroy(), 1000);
      return;
    }
    return this.protocolError(1002, "The relay sent an unknown frame type.");
  }
}

function connectWebSocket(url, options) {
  return new WebSocketClient(url, options);
}

module.exports = { CONNECTING, OPEN, CLOSING, CLOSED, MAX_PAYLOAD, relayUrl, WebSocketClient, connectWebSocket };
