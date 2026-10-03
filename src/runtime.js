"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { startServer } = require("./server");
const { startTunnel } = require("./tunnel");
const { apiRequest } = require("./account");
const { stateDir, readState, writeState, removeState } = require("./state");
const { keepAwake } = require("./awake");
const { getPermissions, requestPermissions } = require("./permissions");

function enablePrivateLog() {
  const file = path.join(stateDir(), "service.log");
  const write = (chunk, encoding, callback) => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) {
        fs.renameSync(file, `${file}.previous`);
      }
      fs.appendFileSync(file, chunk, { mode: 0o600 });
    } catch { /* A full disk must not crash the connection. */ }
    if (typeof encoding === "function") encoding();
    if (typeof callback === "function") callback();
    return true;
  };
  process.stdout.write = write;
  process.stderr.write = write;
}

async function runDaemon({ serve = startServer, tunnelFactory = startTunnel, request = apiRequest,
  permissions = getPermissions, requestNativePermissions = requestPermissions, awakeFactory = keepAwake,
  signal, heartbeatMs = 30000, retryMs = 1000 } = {}) {
  const config = readState("config");
  if (!config?.device_token) throw new Error("Run shapes-bridge install to connect this computer.");
  let stopping = false, server, tunnel, awake, permissionBusy = false;
  let permissionState = {}, connection = "starting", lastHeartbeat = null, lastError = null, registeredEndpoint = null;
  let wake;
  const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  const status = () => writeState("status", {
    pid: process.pid, device_id: config.device_id, name: config.name,
    local_port: server?.address()?.port || null,
    connection, last_heartbeat: lastHeartbeat, updated_at: new Date().toISOString(),
    permissions: permissionState, error: lastError,
  });
  const log = (message) => process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
  const shutdown = () => { stopping = true; wake?.(); tunnel?.child.kill(); server?.closeAllConnections?.(); server?.close(); awake?.stop(); };
  if (signal?.aborted) stopping = true;
  signal?.addEventListener("abort", shutdown, { once: true });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const refreshPermissions = async () => {
    if (permissionBusy) return;
    permissionBusy = true;
    try {
      const requested = readState("permission-request");
      if (requested) {
        removeState("permission-request");
        await requestNativePermissions(requested);
      }
      permissionState = { ...await permissions(), background_service: "enabled", keep_awake: awake?.status() || "disabled" };
      status();
    } catch (error) { log(`Permission check unavailable: ${error.message}`); }
    finally { permissionBusy = false; }
  };

  try {
    if (stopping) return;
    if (config.paused || config.revoked) {
      connection = config.revoked ? "revoked" : "paused";
      status();
      while (!stopping) await sleep(60000);
      return;
    }
    // A fresh per-process secret revokes any old tunnel immediately after restart.
    const token = crypto.randomBytes(32).toString("base64url");
    server = await serve({ port: 0, token });
    awake = awakeFactory({ enabled: config.keep_awake !== false });
    await refreshPermissions();
    const permissionTimer = setInterval(() => {
      if (fs.existsSync(path.join(stateDir(), "permission-request.json"))) void refreshPermissions();
    }, 1000);
    permissionTimer.unref();
    let attempts = 0;
    try {
      while (!stopping) {
        try {
          connection = "connecting"; status();
          tunnel = await tunnelFactory({ port: server.address().port, log });
          let tunnelExited = tunnel.child.exitCode !== null && tunnel.child.exitCode !== undefined;
          tunnel.child.once("exit", () => { tunnelExited = true; wake?.(); });
          tunnel.child.once("error", () => { tunnelExited = true; wake?.(); });
          while (!stopping && !tunnelExited) {
            try {
              await refreshPermissions();
              await request(config.api, "/devices/heartbeat", { bridge_url: tunnel.url, token, permissions: permissionState }, config.device_token);
              registeredEndpoint = { bridge_url: tunnel.url, token };
              connection = "connected"; lastHeartbeat = new Date().toISOString(); lastError = null; attempts = 0; status();
            } catch (error) {
              if (error.status === 401) {
                writeState("config", { ...config, revoked: true });
                connection = "revoked"; lastError = "This computer was removed from Shapes. Run install to reconnect."; status();
                log(lastError);
                tunnel.child.kill(); server.closeAllConnections?.(); server.close(); awake.stop();
                while (!stopping) await sleep(60000);
                return;
              }
              connection = "reconnecting"; lastError = error.message; status();
              log("Waiting for Shapes; retrying automatically.");
            }
            if (!stopping && !tunnelExited) await sleep(heartbeatMs);
          }
          if (!stopping) throw new Error("The secure tunnel closed; reconnecting automatically.");
        } catch (error) {
          if (stopping) break;
          connection = "reconnecting"; lastError = error.message; status(); log(lastError);
          await sleep(Math.min(60000, retryMs * 2 ** Math.min(attempts++, 6)) + Math.floor(Math.random() * retryMs));
        } finally { tunnel?.child.kill(); tunnel = null; }
      }
    } finally { clearInterval(permissionTimer); }
  } finally {
    shutdown();
    if (registeredEndpoint && connection !== "revoked") {
      try { await request(config.api, "/devices/offline", registeredEndpoint, config.device_token, "POST", 2500); }
      catch { /* The heartbeat expires if the network is already unavailable. */ }
    }
    if (connection !== "revoked") { connection = "offline"; status(); }
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    signal?.removeEventListener("abort", shutdown);
  }
}

module.exports = { runDaemon, enablePrivateLog };
