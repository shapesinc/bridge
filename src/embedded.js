"use strict";

const os = require("node:os");
const { readState, writeState, removeState } = require("./state");
const { DEFAULT_API, beginPairing, pollPairing, cancelPairing } = require("./account");
const { createEmbeddedProcess } = require("./embedded-process");
const { PERMISSIONS } = require("./permissions");
const { listAgents, inspectAgent } = require("./agents");
const { openPersonalLogin } = require("./personal-login");
const { createPersonalLoginManager } = require("./personal-codex");
const { createAccountRevocation, validToken } = require("./account-revocation");

const MESSAGES = Object.freeze({
  invalid_request: "This computer request is not supported.",
  account_unverified: "Sign in to connect this computer.",
  account_changed: "The signed-in account changed. Start again.",
  device_unavailable: "This computer is no longer connected to this account.",
  attempt_conflict: "Another connection is already being set up.",
  attempt_not_found: "Start connecting this computer again.",
  pairing_pending: "Approve this computer to continue.",
  connection_pending: "Connecting this computer. Please wait.",
  pairing_expired: "Computer approval expired. Start again.",
  pairing_cancelled: "Computer setup was cancelled.",
  connection_failed: "Could not connect this computer. Try again.",
  cancel_failed: "Could not cancel computer approval. Try again.",
  not_connected: "Connect this computer before requesting permission.",
  agent_login_unavailable: "Install or update this provider's coding app, then try signing in again.",
  agent_login_failed: "Could not open provider sign-in. Try again.",
});
function failure(code) { return Object.assign(new Error(MESSAGES[code]), { code }); }
const identifier = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const permissionStates = new Set(["granted", "denied", "unknown", "unsupported"]);
const deviceCredential = /^sbd_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[A-Za-z0-9_-]{32,128}$/i;

// Private app host boundary. Credentials never appear in returned values, and
// account verification is supplied only by the trusted signed-in host.
function createEmbeddedController({ read = readState, write = writeState, remove = removeState,
  begin = beginPairing, poll = pollPairing, cancel = cancelPairing,
  runtime = createEmbeddedProcess(), api = DEFAULT_API, name = os.hostname(), now = Date.now,
  discoverPersonalAgents = listAgents, inspectPersonalAgent = inspectAgent, launchPersonalLogin = openPersonalLogin,
  personalLogin = createPersonalLoginManager(),
  revocations = createAccountRevocation({ read, write }), revocationPollMs = 250,
  readinessMs = 20000, sleep = (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(failure("pairing_cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  }) } = {}) {
  let account = null, attempt = null, completed = null, closed = false, lastError = null, generation = 0;
  let observedRevocation = "none", accountRevocation = "none", revocationFailure = null, revocationWork = null;
  const cancelledIds = new Set();
  let queue = Promise.resolve();
  const serial = (operation) => { const result = queue.then(operation); queue = result.catch(() => {}); return result; };
  const config = () => { const value = read("config"); if (value && value.mode !== "embedded") throw failure("invalid_request"); return value; };
  const ownerMatches = (value) => Boolean(account && value?.owner_user_id === account.userId);
  const usable = (value) => ownerMatches(value) && account.deviceIds.has(value.device_id) && !value.revoked && value.api === api;
  const authorized = (userId) => { requireCurrentRevocation(); if (closed || !account) throw failure("account_unverified"); if (account.userId !== userId) throw failure("account_changed"); };
  function status() {
    observeRevocation();
    const saved = config(), receipt = read("status"), visible = ownerMatches(saved);
    const live = runtime.running();
    const fresh = live && receipt?.pid === runtime.pid() && receipt?.device_id === saved?.device_id &&
      now() - Date.parse(receipt.updated_at) >= 0 && now() - Date.parse(receipt.updated_at) < 90000;
    const online = Boolean(usable(saved) && !saved.paused && fresh && receipt.connection === "connected" && now() - Date.parse(receipt.last_heartbeat) < 90000);
    // Initial tunnel reachability can take several heartbeats. Keep the owned
    // setup cancellable and visibly connecting while completeConnect retries;
    // revocation, explicit failures, and later connection loss remain errors.
    const waitingForFirstHeartbeat = attempt && !attempt.cancelled && receipt?.last_heartbeat == null;
    const error = lastError || (visible && (!usable(saved) || saved.revoked) ? "device_unavailable" :
      fresh && (receipt.connection === "revoked" || receipt.connection === "reconnecting" && !waitingForFirstHeartbeat) ? "connection_failed" : null);
    const state = error ? "error" : attempt && !attempt.cancelled ? "connecting" :
      !visible ? "disconnected" : saved.paused ? (live ? "error" : "paused") : online ? "connected" : live ? "connecting" : "disconnected";
    return { state, online, ...(visible ? { deviceId: saved.device_id, deviceName: saved.name } : {}),
      permissions: Object.fromEntries(PERMISSIONS.map((key) => [key, fresh && visible && permissionStates.has(receipt.permissions?.[key]) ? receipt.permissions[key] : "unknown"])),
      ...(error ? { error } : {}) };
  }
  function invalidate() { generation++; if (attempt) { attempt.cancelled = true; attempt.controller.abort(); } }
  function withdrawAuthority() {
    account = null; completed = null; invalidate();
    // Do not queue revocation behind pairing/readiness or a slow provider. The
    // serialized consumer still awaits this owned stop before acknowledging.
    void runtime.stop().catch(() => {});
  }
  function observeRevocation() {
    try {
      const receipt = revocations.read();
      const changed = receipt.revocationToken !== observedRevocation;
      if (receipt.pending || changed && account) {
        if (changed || account || attempt && !attempt.cancelled) withdrawAuthority();
        const saved = config();
        if (saved?.resume_on_startup) write("config", { ...saved, resume_on_startup: false }, { durable: true });
      }
      observedRevocation = receipt.revocationToken;
      revocationFailure = null;
      return receipt;
    } catch (error) {
      if (!revocationFailure || account || attempt && !attempt.cancelled) withdrawAuthority();
      revocationFailure = error;
      throw failure("connection_failed");
    }
  }
  function requireCurrentRevocation() {
    const receipt = observeRevocation();
    if (receipt.pending || receipt.revocationToken !== accountRevocation) throw failure("account_changed");
    return receipt;
  }
  async function consumeRevocation() {
    // A bounded batch leaves a racing newer clear pending. The live observer or
    // next request retries it; no stale proof can pass the exact token check.
    for (let count = 0; count < 4; count++) {
      const receipt = observeRevocation();
      if (!receipt.pending) return receipt;
      const result = await revocations.consume(async () => {
        withdrawAuthority();
        let persistenceError;
        try {
          const saved = config();
          if (saved) write("config", { ...saved, resume_on_startup: false }, { durable: true });
        } catch (error) { persistenceError = error; }
        await suspend();
        if (persistenceError) throw persistenceError;
        // Re-read, rather than overwrite a fresh config with a captured copy.
        const saved = config();
        if (saved) write("config", { ...saved, resume_on_startup: false }, { durable: true });
      });
      if (!result.pending) return result;
    }
    throw failure("account_changed");
  }
  function observeInBackground() {
    if (closed || revocationWork) return;
    let pending = false;
    try { pending = observeRevocation().pending; } catch { return; }
    if (!pending) return;
    revocationWork = serial(consumeRevocation).catch(() => {}).finally(() => { revocationWork = null; });
  }
  const revocationTimer = setInterval(observeInBackground, Math.max(25, Math.min(revocationPollMs, 1000)));
  revocationTimer.unref?.();
  function pairingCode(pending) {
    if (pending.device_code) return pending.device_code;
    const prefix = `sbd_${pending.deviceId}.`;
    if (typeof pending.device_token !== "string" || !pending.device_token.startsWith(prefix)) throw failure("cancel_failed");
    return pending.device_token.slice(prefix.length);
  }
  async function cancelSaved() {
    const pending = read("embedded-pairing");
    if (!pending) return;
    // Keep the private cancellation capability until the server confirms it or
    // its own expiry has passed. A failed cancellation can be retried on reopen.
    if (pending.expiresAt > now()) {
      try { await cancel({ api, pairing_id: pending.pairing_id, device_code: pairingCode(pending) }); }
      catch (error) { if (![404, 410].includes(error.status)) { lastError = "cancel_failed"; throw failure("cancel_failed"); } }
    }
    const saved = config();
    if (pending.deviceId && saved?.device_id === pending.deviceId) remove("config");
    remove("embedded-pairing");
  }
  async function suspend() {
    remove("permission-request");
    const results = await Promise.allSettled([runtime.stop(), cancelSaved(), personalLogin.cancel()]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) { lastError = failed.reason.code === "cancel_failed" ? "cancel_failed" : "connection_failed"; throw failure(lastError); }
    attempt = null;
  }
  const current = (value) => { authorized(value.expectedUserId); if (attempt !== value || value.cancelled) throw failure("pairing_cancelled"); };
  async function startSaved(value) {
    requireCurrentRevocation();
    if (!usable(value)) throw failure("device_unavailable");
    if (runtime.running()) return;
    remove("status"); remove("permission-request");
    await runtime.start();
    try { requireCurrentRevocation(); }
    catch (error) { await runtime.stop(); throw error; }
  }
  function resumeSavedConnection() {
    // Host lifecycle only, never an RPC or a substitute for a verified web
    // account. The daemon publishes its fresh endpoint only after the server
    // authenticates the existing device credential on heartbeat. An older
    // config without this marker needs one verified foreground attachment.
    return serial(async () => {
      const revocation = await consumeRevocation();
      if (closed || account || read("embedded-pairing")) return;
      const saved = config();
      if (!saved || saved.resume_on_startup !== true || saved.paused || saved.revoked || saved.api !== api ||
          !identifier(saved.owner_user_id) || !identifier(saved.device_id) || typeof saved.device_token !== "string" || !deviceCredential.test(saved.device_token) ||
          !saved.device_token.startsWith(`sbd_${saved.device_id}.`)) return;
      if (!runtime.running()) {
        remove("status"); remove("permission-request");
        await runtime.start();
        const latest = observeRevocation();
        if (latest.pending || latest.revocationToken !== revocation.revocationToken) {
          await runtime.stop(); await consumeRevocation();
        }
      }
    });
  }
  function beginConnect({ attemptId, expectedUserId }) {
    if (!identifier(attemptId) || !identifier(expectedUserId)) return Promise.reject(failure("invalid_request"));
    const startedGeneration = generation;
    return serial(async () => {
      authorized(expectedUserId);
      if (cancelledIds.has(attemptId) || startedGeneration !== generation) throw failure("pairing_cancelled");
      if (attempt) {
        if (attempt.id !== attemptId || attempt.expectedUserId !== expectedUserId || attempt.cancelled) throw failure("attempt_conflict");
        return attempt.public;
      }
      await cancelSaved();
      authorized(expectedUserId);
      if (cancelledIds.has(attemptId) || startedGeneration !== generation) throw failure("pairing_cancelled");
      const value = { id: attemptId, expectedUserId, controller: new AbortController(), cancelled: false };
      attempt = value; completed = null; lastError = null;
      const saved = config();
      if (usable(saved)) {
        // Retrying an already-enabled device does not grant new consent. If
        // this attempt is cancelled (including app Quit), keep its existing
        // reopen behavior; only Disconnect should persist a new pause.
        value.wasEnabled = !saved.paused;
        value.public = { attemptId, deviceId: saved.device_id };
        return value.public;
      }
      try {
        const pairing = await begin({ api, name, signal: value.controller.signal });
        if (!identifier(pairing.pairing_id) || typeof pairing.device_code !== "string" || !pairing.device_code || pairing.device_code.length > 512 ||
          typeof pairing.user_code !== "string" || !/^[A-Z0-9-]{4,32}$/i.test(pairing.user_code)) throw failure("connection_failed");
        // Persist before exposing the approval code so cancellation survives a
        // controller crash or a navigation during the approval request.
        write("embedded-pairing", { pairing_id: pairing.pairing_id, device_code: pairing.device_code,
          expiresAt: now() + Math.min(Math.max(Number(pairing.expires_in) || 600, 1), 600) * 1000 });
        current(value);
        value.public = { attemptId, userCode: pairing.user_code };
        return value.public;
      } catch (error) {
        if (value.cancelled) throw failure("pairing_cancelled");
        attempt = null; lastError = "connection_failed"; throw failure("connection_failed");
      }
    });
  }
  function completeConnect({ attemptId }) {
    if (!identifier(attemptId)) return Promise.reject(failure("invalid_request"));
    return serial(async () => {
      if (completed?.id === attemptId && usable(config())) return status();
      const value = attempt;
      if (!value || value.id !== attemptId) throw failure("attempt_not_found");
      current(value);
      const deadline = now() + readinessMs;
      let saved = config();
      if (value.public.deviceId || value.deviceId) {
        if (!usable(saved) || saved.device_id !== (value.public.deviceId || value.deviceId)) throw failure("device_unavailable");
      } else {
        const pending = read("embedded-pairing");
        if (!pending || pending.expiresAt <= now()) throw failure("pairing_expired");
        let result;
        try { result = await poll({ api, pairing_id: pending.pairing_id, device_code: pending.device_code, signal: value.controller.signal }); }
        catch { throw failure(value.cancelled ? "pairing_cancelled" : "connection_failed"); }
        current(value);
        if (result.status === "pending") throw failure("pairing_pending");
        if (result.status === "cancelled") throw failure("pairing_cancelled");
        if (result.status !== "approved") throw failure("pairing_expired");
        if (result.owner_user_id !== value.expectedUserId || !identifier(result.device_id) || !deviceCredential.test(result.device_token) ||
          result.device_token !== `sbd_${result.device_id}.${pairingCode(pending)}`) {
          invalidate(); await cancelSaved(); attempt = null; throw failure("account_changed");
        }
        // The page refreshes its authenticated device list after approval. The
        // private server owner and that current list must both agree.
        if (!account.deviceIds.has(result.device_id)) throw failure("device_unavailable");
        // Once the runtime can read files, retain only the full recognizable
        // credential, which the existing tool-result redactor already masks.
        // The bare pairing secret is derived in memory only for cancellation.
        write("embedded-pairing", { pairing_id: pending.pairing_id, expiresAt: pending.expiresAt,
          deviceId: result.device_id, device_token: result.device_token });
        saved = { mode: "embedded", api, owner_user_id: result.owner_user_id, device_id: result.device_id,
          device_token: result.device_token, name, keep_awake: true };
        value.deviceId = result.device_id;
      }
      current(value);
      saved = { ...saved, paused: false, revoked: false };
      write("config", saved);
      try {
        await startSaved(saved); current(value);
        while (!status().online) {
          current(value);
          if (!runtime.running()) throw failure("connection_failed");
          if (now() >= deadline) throw failure("connection_pending");
          await sleep(Math.min(250, deadline - now()), value.controller.signal);
        }
        current(value);
      }
      catch (error) {
        const code = Object.hasOwn(MESSAGES, error.code) ? error.code : "connection_failed";
        if (code !== "connection_pending") lastError = code;
        throw failure(code);
      }
      completed = { id: attemptId, deviceId: saved.device_id, pairing: read("embedded-pairing"), wasEnabled: value.wasEnabled === true };
      remove("embedded-pairing");
      write("config", { ...config(), resume_on_startup: true });
      attempt = null; lastError = null;
      return status();
    });
  }
  function cancelConnect({ attemptId }) {
    if (!identifier(attemptId)) return Promise.reject(failure("invalid_request"));
    cancelledIds.add(attemptId);
    if (cancelledIds.size > 128) cancelledIds.delete(cancelledIds.values().next().value);
    if (attempt?.id !== attemptId) {
      if (completed?.id !== attemptId) return Promise.resolve(status());
      const receipt = completed; completed = null;
      return serial(async () => {
        const saved = config();
        if (saved?.device_id !== receipt.deviceId) return status();
        if (!receipt.wasEnabled) write("config", { ...saved, paused: true });
        if (receipt.pairing) write("embedded-pairing", receipt.pairing);
        await suspend(); lastError = null; return status();
      });
    }
    const saved = config();
    // Never write paused:false here: a newer Disconnect, removal or revocation
    // may already have stopped access while this attempt was in flight.
    if (!attempt.wasEnabled && saved && saved.device_id === (attempt.public?.deviceId || attempt.deviceId)) write("config", { ...saved, paused: true });
    invalidate();
    return serial(async () => { await suspend(); lastError = null; return status(); });
  }
  function disconnect() {
    invalidate();
    const saved = config();
    if (saved) write("config", { ...saved, paused: true });
    return serial(async () => { await suspend(); lastError = null; return status(); });
  }
  function detach() {
    // A UI may leave its durable host without withdrawing an established
    // connection. Setup still belongs to that UI: invalidate immediately so a
    // queued begin or an in-flight approval cannot finish after it leaves.
    const pending = attempt;
    const saved = config();
    // Match cancellation's consent boundary: abandoning an enabled device's
    // retry is not a new pause. Never restore paused:false, because a newer
    // Disconnect or account removal may already have withdrawn that consent.
    if (pending && !pending.wasEnabled && saved && saved.device_id === (pending.public?.deviceId || pending.deviceId)) {
      write("config", { ...saved, paused: true });
    }
    invalidate();
    return serial(async () => {
      await personalLogin.cancel();
      if (pending || read("embedded-pairing")) {
        await suspend();
        lastError = null;
      }
      return status();
    });
  }
  function updateAccount({ userId, deviceIds, verified, revocationToken = "none" }) {
    if (typeof verified !== "boolean" || !(userId === null || identifier(userId)) || !Array.isArray(deviceIds) || deviceIds.length > 500 || !deviceIds.every(identifier)) return Promise.reject(failure("invalid_request"));
    if (!validToken(revocationToken)) return Promise.reject(failure("invalid_request"));
    let revocation;
    try { revocation = observeRevocation(); } catch (error) { return Promise.reject(error); }
    if (verified && revocationToken !== revocation.revocationToken) return Promise.reject(failure("account_changed"));
    if (revocation.pending) {
      return serial(consumeRevocation).then(() => updateAccount({ userId, deviceIds, verified, revocationToken }));
    }
    const next = verified && userId ? { userId, deviceIds: new Set(deviceIds) } : null;
    const changed = account?.userId !== next?.userId;
    const firstAccount = account === null;
    account = next;
    accountRevocation = revocation.revocationToken;
    // Logout, failed verification, switching accounts and device removal stop
    // automatic restart durably without changing the existing explicit reopen
    // consent. Only a later verified owner can enable startup again.
    let persistenceError, adoptExisting = false;
    try {
      const savedAccount = config();
      // Startup can own a daemon without foreground account authority. A new
      // independently verified owner may adopt that exact approved connection;
      // switching an already known account still cancels its runtime and jobs.
      adoptExisting = firstAccount && !attempt && runtime.running() && savedAccount?.resume_on_startup === true &&
        !savedAccount.paused && usable(savedAccount);
      if (savedAccount?.resume_on_startup && !usable(savedAccount)) write("config", { ...savedAccount, resume_on_startup: false });
    } catch (error) { persistenceError = error; }
    const attemptDevice = attempt?.public?.deviceId || attempt?.deviceId;
    const removedDuringAttempt = Boolean(account && attemptDevice && !account.deviceIds.has(attemptDevice));
    if (removedDuringAttempt) {
      const saved = config();
      if (saved?.device_id === attemptDevice) write("config", { ...saved, paused: true });
    }
    if (changed || !account || removedDuringAttempt || persistenceError) invalidate();
    return serial(async () => {
      if (closed) throw failure("account_unverified");
      if (persistenceError) { await suspend(); throw persistenceError; }
      if ((changed && !adoptExisting) || !account || attempt?.cancelled || !attempt && read("embedded-pairing")) await suspend();
      requireCurrentRevocation();
      const saved = config();
      if (!usable(saved)) { await runtime.stop(); return status(); }
      if (!saved.paused && !attempt && !runtime.running()) await startSaved(saved);
      const latest = config();
      requireCurrentRevocation();
      if (!closed && !attempt && usable(latest) && !latest.paused && runtime.running() && !latest.resume_on_startup) {
        write("config", { ...latest, resume_on_startup: true });
      }
      if (lastError !== "cancel_failed") lastError = null;
      return status();
    });
  }
  function requestPermission({ permission }) {
    if (!PERMISSIONS.includes(permission)) return Promise.reject(failure("invalid_request"));
    return serial(async () => {
      requireCurrentRevocation();
      if (closed || !usable(config()) || config().paused || !runtime.running()) throw failure("not_connected");
      write("permission-request", { permission }); return status();
    });
  }
  function dispose() { closed = true; clearInterval(revocationTimer); account = null; invalidate(); return serial(suspend); }
  function lifecycleStatus() {
    // Wait behind startup and mutations. This contains no account identity,
    // credential, permission grant or online claim; only the owning host uses
    // it to decide whether its private process tree can retire.
    return serial(() => ({ active: runtime.running() || Boolean(attempt && !attempt.cancelled) }));
  }
  async function listPersonalAgents({ expectedUserId }) {
    if (!identifier(expectedUserId)) throw failure("invalid_request");
    authorized(expectedUserId);
    const result = await discoverPersonalAgents(os.homedir());
    authorized(expectedUserId);
    return result;
  }
  async function openAgentLogin({ expectedUserId, agent }) {
    if (!identifier(expectedUserId) || !["codex", "claude"].includes(agent)) throw failure("invalid_request");
    const startedGeneration = generation;
    const assertCurrent = () => {
      authorized(expectedUserId);
      if (generation !== startedGeneration) throw failure("account_changed");
    };
    assertCurrent();
    const selected = await inspectPersonalAgent(agent, os.homedir());
    assertCurrent();
    if (!["ready", "auth_required"].includes(selected.status) || !selected.executable) throw failure("agent_login_unavailable");
    let result;
    try {
      result = selected.transport === "bundled_personal"
        ? await personalLogin.start(selected, assertCurrent)
        : await launchPersonalLogin(selected);
    }
    catch { throw failure("agent_login_failed"); }
    assertCurrent();
    return selected.transport === "bundled_personal" ? result : { opened: true, cancellable: false };
  }
  async function cancelAgentLogin({ expectedUserId, agent }) {
    if (!identifier(expectedUserId) || !["codex", "claude"].includes(agent)) throw failure("invalid_request");
    authorized(expectedUserId);
    const result = agent === "codex" ? await personalLogin.cancel() : { cancelled: false };
    authorized(expectedUserId);
    return result;
  }
  return { status, beginConnect, completeConnect, cancelConnect, disconnect, detach, updateAccount, requestPermission,
    resumeSavedConnection, backgroundActive: () => runtime.running(), lifecycleStatus,
    listPersonalAgents, openAgentLogin, cancelAgentLogin, dispose };
}

module.exports = { createEmbeddedController, failure, MESSAGES };
