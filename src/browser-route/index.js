"use strict";

// "Agent browsing through this computer", inside the Bridge daemon. It asks shapes.inc for a relay
// token with this computer's credential, keeps the device connected to the relay, refreshes the
// token before it expires (and at once when the relay refuses it), and reports counts for status.json.
// Hostnames stay in this process: logs and status carry counts and refusal codes only.
const { startDevice } = require("./device");
const { relayUrl } = require("./ws-client");

const ROUTE = "/devices/browser-route";
// The computer default from architecture/DEVICE_ROUTING.md (app repo): 2 GiB a day.
const DAILY_BYTES = 2 * 1024 ** 3;
// Not offered to this account (any more): ask again this often.
const RECHECK_MS = 30 * 60_000;
const MAX_RETRY_MS = 5 * 60_000;
const MIN_REFRESH_MS = 60_000;
const MAX_TOKEN_SECONDS = 7 * 86_400;

const DESCRIPTIONS = {
  on: "connected",
  offline: "not connected right now; retrying automatically",
  not_available: "not available for this shapes.inc account yet",
  off: "stopped",
};

/** A usable relay grant from POST /bridge/devices/browser-route, or an error (403-like when it's refused). */
function grantFrom(result) {
  if (result?.enabled !== true) {
    throw Object.assign(new Error("Agent browsing through this computer isn't available for this account."), { status: 403, body: result });
  }
  if (typeof result.relay_url !== "string" || typeof result.relay_token !== "string" || !result.relay_token) {
    throw new Error("shapes.inc returned an incomplete browser route.");
  }
  relayUrl(result.relay_url);
  const seconds = Number(result.expires_in);
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_TOKEN_SECONDS) : 3600;
  return { url: result.relay_url, token: result.relay_token, expiresInMs: lifetime * 1000 };
}

/**
 * Starts the route. `request` is account.apiRequest (injectable). `onChange()` fires when status()
 * changes; `onRevoked()` when shapes.inc answers 401 (this computer was removed). `usage` is
 * {day, bytes} carried over from the last run, for the daily cap.
 */
function startBrowserRoute({ config, request, log = () => {}, onChange = () => {}, onRevoked = () => {}, usage,
  deviceFactory = startDevice, dailyBytes = DAILY_BYTES, retryMs = 5_000, recheckMs = RECHECK_MS,
  minRefreshMs = MIN_REFRESH_MS, statsMs = 60_000 } = {}) {
  let state = "offline";
  let stopped = false, device, timer, inFlight = false, attempts = 0, refusals = 0;
  let lastUsage = usage;
  let stats = { opened: 0, bytes: 0, refused: {} };

  const setState = (next) => {
    if (state !== next) {
      state = next;
      log(`Agent browsing through this computer: ${DESCRIPTIONS[next]}.`);
    }
    onChange();
  };
  const schedule = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(refresh, ms);
  };
  const backoff = () => Math.min(MAX_RETRY_MS, retryMs * 2 ** Math.min(attempts++, 8)) + Math.floor(Math.random() * retryMs);
  const stopDevice = () => {
    if (!device) return;
    lastUsage = device.usage;
    device.stop();
    device = undefined;
  };

  const onActivity = (event) => {
    if (stopped) return;
    if (event.type === "connected") { refusals = 0; setState("on"); }
    else if (event.type === "offline") { if (state === "on") setState("offline"); else onChange(); }
    else if (event.type === "open") { stats.opened++; onChange(); }
    else if (event.type === "close") { stats.bytes += event.bytes || 0; onChange(); }
    else if (event.type === "refused") stats.refused[event.reason] = (stats.refused[event.reason] || 0) + 1;
  };

  // The relay refused the token (expired, or revoked there). The first refusal after a working
  // connection asks shapes.inc again at once; repeated refusals back off.
  const onTokenRefused = () => {
    if (stopped) return;
    setState("offline");
    if (!inFlight) schedule(refusals++ === 0 ? 0 : backoff());
  };

  async function refresh() {
    timer = undefined;
    if (stopped || inFlight) return;
    inFlight = true;
    let grant;
    try {
      grant = grantFrom(await request(config.api, ROUTE, { enabled: true }, config.device_token));
    } catch (error) {
      if (stopped) return;
      if (error.status === 401) {
        // The computer was removed from the account; the daemon's revocation handling takes over.
        stop();
        onRevoked();
        return;
      }
      if (error.status === 403) {
        stopDevice();
        setState("not_available");
        schedule(recheckMs);
        return;
      }
      // shapes.inc is unreachable: a connection that is up keeps its token (still valid); try again soon.
      if (!device?.connected) setState("offline");
      schedule(backoff());
      return;
    } finally { inFlight = false; }
    if (stopped) return;
    attempts = 0;
    if (device) device.update(grant);
    else device = deviceFactory({ url: grant.url, token: grant.token, dailyBytes, usage: lastUsage, onActivity, onTokenRefused });
    // Ask for the next token at 80% of this one's life, so a reconnect never uses an expired one.
    schedule(Math.max(minRefreshMs, grant.expiresInMs * 0.8));
  }

  // Counts only, once a minute when anything happened: never hostnames or bytes per site.
  const statsTimer = setInterval(() => {
    const refused = Object.entries(stats.refused);
    if (!stats.opened && !refused.length) return;
    const parts = [`${stats.opened} connection${stats.opened === 1 ? "" : "s"} opened`, `${(stats.bytes / 1048576).toFixed(1)} MB carried`];
    if (refused.length) parts.push(`refused ${refused.map(([reason, n]) => `${n} (${reason})`).join(", ")}`);
    log(`Agent browsing through this computer, last minute: ${parts.join(", ")}.`);
    stats = { opened: 0, bytes: 0, refused: {} };
  }, statsMs);
  statsTimer.unref?.();

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearInterval(statsTimer);
    stopDevice();
    state = "off";
    onChange();
  }

  void refresh();

  return {
    /** The kill switch: closes the relay connection, which drops every open connection at once. */
    stop,
    status() {
      const day = new Date().toDateString();
      const used = device?.usage || lastUsage;
      return { state, open: device?.open || 0, bytes_today: used?.day === day ? used.bytes : 0, day };
    },
  };
}

module.exports = { ROUTE, DAILY_BYTES, grantFrom, startBrowserRoute };
