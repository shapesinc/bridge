"use strict";

const { readState, writeState, removeState } = require("./state");
const { pairDevice, apiRequest } = require("./account");
const { startService, stopService, installBundledMacApp } = require("./service");

// The native controller and CLI use these same lifecycle primitives. Nothing
// here grants a chat access, requests OS permission, or starts an agent job.
function createDesktopController({ read = readState, write = writeState, remove = removeState,
  pair = pairDevice, start = startService, stop = stopService,
  install = installBundledMacApp, request = apiRequest, publish = () => {},
  isRunning = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  now = Date.now } = {}) {
  let operation = null, pairing = null, error = null;
  function status() {
    const config = read("config"), saved = read("status");
    const recent = saved && saved.device_id === config?.device_id && isRunning(saved.pid) &&
      now() - Date.parse(saved.updated_at) < 90000;
    const connection = operation ? "pairing" : !config ? "disconnected" : config.revoked ? "revoked" :
      config.paused ? (recent && !["offline", "paused"].includes(saved.connection) ? "disconnect_failed" : "paused") : recent ? saved.connection : "offline";
    return { connection, name: config?.name || null, pairing, error: error || (recent ? saved.error : null),
      permissions: recent ? saved.permissions : {}, version: require("../package.json").version };
  }
  const emit = () => { const value = status(); publish(value); return value; };
  async function connect() {
    if (operation) return status(); // A repeated click resumes the same approval.
    const controller = new AbortController();
    operation = controller; error = null;
    emit();
    try {
      let config = read("config");
      if (!config?.device_token || config.revoked) {
        config = await pair({ signal: controller.signal, onCode(value) {
          // Never put the private poll code or persistent token on stdout/UI.
          pairing = { code: value.user_code, url: value.verification_uri_complete };
          emit();
        } });
      }
      controller.signal.throwIfAborted();
      // Copy the signed runtime shipped with the parent app; no npm, download,
      // shell command, or external Node installation is involved.
      await install();
      controller.signal.throwIfAborted();
      write("config", { ...config, paused: false, revoked: false, keep_awake: config.keep_awake !== false });
      remove("status");
      await start();
    } catch (cause) {
      if (!controller.signal.aborted) error = cause.message;
    } finally {
      if (operation === controller) { operation = null; pairing = null; }
      emit();
    }
    return status();
  }
  async function pause() {
    operation?.abort(new Error("Computer approval cancelled."));
    operation = null; pairing = null; error = null;
    const config = read("config");
    if (config) {
      // Persist first so a concurrent restart cannot restore remote access.
      write("config", { ...config, paused: true });
      try {
        stop();
        await request(config.api, "/devices/offline", {}, config.device_token, "POST", 2500);
      } catch (cause) { error = cause.message; }
    }
    return emit();
  }
  function permissions() {
    if (!["connected", "connecting", "reconnecting"].includes(status().connection)) {
      throw new Error("Connect this computer before requesting permissions.");
    }
    write("permission-request", {});
    return emit();
  }
  // Closing a setup window cancels unfinished pairing, while an established
  // background connection keeps the same explicit pause behavior as the CLI.
  function dispose() { operation?.abort(new Error("Computer approval cancelled.")); }
  return { status, connect, pause, permissions, dispose };
}

module.exports = { createDesktopController };
