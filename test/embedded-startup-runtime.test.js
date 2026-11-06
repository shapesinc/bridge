"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const http = require("node:http"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createEmbeddedController } = require("../src/embedded");
const { createEmbeddedHost } = require("../src/embedded-host");
const { createEmbeddedProcess } = require("../src/embedded-process");
const { spawnOwned } = require("../src/owned-process");
const { readState, writeState } = require("../src/state");
const { parseRequest } = require("../src/embedded-protocol");

const DEVICE = "11111111-1111-4111-8111-111111111111", TOKEN = `sbd_${DEVICE}.${"c".repeat(43)}`;
const available = process.platform !== "win32" || Boolean(process.env.SHAPES_TEST_JOB_HOST);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, message = "runtime did not settle") {
  const deadline = Date.now() + 8000;
  while (!check()) { if (Date.now() > deadline) assert.fail(message); await delay(20); }
}

// Real durable pipe host, child daemon, private disk state and authenticated
// computer HTTP endpoint. Only the remote device authority, tunnel and OS
// probes are local fixtures. No production/backend/provider traffic occurs.
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-startup-"));
  const previous = process.env.SHAPES_BRIDGE_HOME;
  process.env.SHAPES_BRIDGE_HOME = directory;
  const hosts = [], pids = new Set(), requests = [], accepted = [], offline = [];
  let credentialValid = true, unavailable = false;
  const backend = http.createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
    requests.push(request.url);
    if (!["/bridge/devices/heartbeat", "/bridge/devices/offline"].includes(request.url)) {
      response.writeHead(404); response.end("{}"); return;
    }
    if (!credentialValid || request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401); response.end("{}"); return;
    }
    if (request.url.endsWith("heartbeat")) {
      if (unavailable) { response.writeHead(503); response.end("{}"); return; }
      // Match the real backend's endpoint-readiness probe before publication.
      try {
        const health = await fetch(`${body.bridge_url}/sysinfo`, { headers: { "x-token": body.token } });
        if (health.status !== 200) throw new Error("endpoint unavailable");
        await health.json();
      } catch { response.writeHead(409); response.end("{}"); return; }
      if (!credentialValid) { response.writeHead(401); response.end("{}"); return; }
      accepted.push(body);
    } else offline.push(body);
    response.writeHead(200, { "content-type": "application/json" }); response.end('{"success":true}');
  });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const api = `http://127.0.0.1:${backend.address().port}`;
  const source = path.resolve(__dirname, "../src");
  const daemon = `
    const {EventEmitter}=require('node:events');
    const windows=process.platform==='win32';
    if(windows)process.stdout.write(JSON.stringify({pid:process.pid})+'\\n');
    const parent=require(${JSON.stringify(path.join(source, "embedded-lifetime"))}).parentLifetime(process,windows?{input:process.stdin}:{});
    const {runDaemon,enablePrivateLog}=require(${JSON.stringify(path.join(source, "runtime"))});
    enablePrivateLog();
    runDaemon({signal:parent.signal,heartbeatMs:60,retryMs:5,disableStartup(){},
      permissions:async()=>({accessibility:'unknown'}),requestNativePermissions:async()=>{},
      awakeFactory:()=>({status:()=> 'disabled',stop(){}}),
      tunnelFactory:async({port})=>{const child=new EventEmitter();child.exitCode=null;
        child.kill=()=>{child.exitCode=0;child.emit('exit',0)};
        return {child,url:'http://127.0.0.1:'+port}}})
      .then(()=>{parent.dispose();process.exit(0)},()=>process.exit(1));`;
  function seed(overrides = {}) {
    writeState("config", { mode: "embedded", api, owner_user_id: "owner-a", device_id: DEVICE,
      device_token: TOKEN, name: "Test PC", keep_awake: false, paused: false, revoked: false,
      resume_on_startup: true, ...overrides });
  }
  async function launch() {
    const runtime = createEmbeddedProcess({ graceMs: 1000,
      spawnProcess: (file, args, options) => spawn(file, ["-e", daemon], options),
      ownedSpawn: (file, args, options) => spawnOwned(file, ["-e", daemon], options, { host: process.env.SHAPES_TEST_JOB_HOST }),
    });
    const controller = createEmbeddedController({ api, runtime });
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\bridge-startup-${crypto.randomUUID()}` : path.join(directory, `${hosts.length}.sock`);
    let idle = false;
    const host = createEmbeddedHost({ controller, endpoint, token: crypto.randomBytes(32).toString("hex"), version: "test-startup",
      idleTimeoutMs: 40, onIdle: () => { idle = true; } });
    hosts.push(host); await host.start();
    if (runtime.pid()) pids.add(runtime.pid());
    return { host, controller, runtime, idle: () => idle };
  }
  t.after(async () => {
    for (const host of hosts) await host.dispose();
    for (const pid of pids) await until(() => !alive(pid), `owned daemon ${pid} survived cleanup`);
    backend.closeAllConnections(); await new Promise((resolve) => backend.close(resolve));
    if (previous === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { seed, launch, requests, accepted, offline, pids,
    revoke: () => { credentialValid = false; }, outage: (value) => { unavailable = value; } };
}

test("fresh host resumes established access with device authority and leaves foreground authority unverified", { skip: !available, timeout: 20000 }, async (t) => {
  const f = await fixture(t); f.seed();
  const first = await f.launch();
  await until(() => f.accepted.length >= 3);
  assert.equal(first.host.server.listening, true); assert.equal(first.idle(), false);
  assert.equal(first.controller.status().state, "disconnected"); assert.equal(first.controller.status().deviceId, undefined);
  assert.equal(first.controller.status().online, false);
  for (const [method, params, code] of [
    ["beginConnect", { attemptId: "forged", expectedUserId: "owner-a" }, "account_unverified"],
    ["listPersonalAgents", { expectedUserId: "owner-a" }, "account_unverified"],
    ["openAgentLogin", { expectedUserId: "owner-a", agent: "codex" }, "account_unverified"],
    ["requestPermission", { permission: "accessibility" }, "not_connected"],
  ]) await assert.rejects(first.controller[method](params), { code });
  for (const operation of ["resumeSavedConnection", "backgroundActive"]) {
    assert.throws(() => parseRequest(JSON.stringify({ version: 1, id: "one", operation, params: {} })), { code: "invalid_request" });
  }
  const oldPid = first.runtime.pid(), oldEndpoint = f.accepted.at(-1);
  await first.controller.resumeSavedConnection(); assert.equal(first.runtime.pid(), oldPid);
  await first.controller.detach(); assert.equal(first.runtime.pid(), oldPid);
  await first.host.dispose(); await until(() => !alive(oldPid));
  assert.equal(readState("config").resume_on_startup, true); assert.equal(f.offline.length, 1);
  await assert.rejects(fetch(`${oldEndpoint.bridge_url}/sysinfo`, { headers: { "x-token": oldEndpoint.token } }));
  const count = f.accepted.length, second = await f.launch();
  await until(() => f.accepted.length > count);
  assert.notEqual(second.runtime.pid(), oldPid); assert.notEqual(f.accepted.at(-1).token, oldEndpoint.token);
  assert.equal(second.controller.status().deviceId, undefined);
  const resumedPid = second.runtime.pid(), resumedEndpoint = f.accepted.at(-1), offlineBeforeAdoption = f.offline.length;
  const verified = await second.controller.updateAccount({ userId: "owner-a", deviceIds: [DEVICE], verified: true });
  if (second.runtime.pid()) f.pids.add(second.runtime.pid());
  await until(() => second.controller.status().online);
  assert.equal(verified.deviceId, DEVICE); assert.equal(readState("config").device_token, TOKEN);
  assert.equal(second.runtime.pid(), resumedPid, "same verified owner must adopt without terminating background work");
  assert.equal(f.offline.length, offlineBeforeAdoption);
  assert.equal(f.accepted.at(-1).token, resumedEndpoint.token);
});

test("startup credential rejection and later revocation persist and cannot republish on next host", { skip: !available, timeout: 20000 }, async (t) => {
  const f = await fixture(t); f.seed({ device_token: `sbd_${DEVICE}.${"x".repeat(43)}` });
  let current = await f.launch();
  await until(current.idle); assert.equal(f.accepted.length, 0); assert.equal(readState("config").revoked, true);
  const rejected = f.requests.length;
  current = await f.launch(); await until(current.idle); assert.equal(f.requests.length, rejected);
  f.seed(); current = await f.launch(); await until(() => f.accepted.length >= 1);
  const count = f.accepted.length; f.revoke();
  await until(current.idle); assert.equal(readState("status").connection, "revoked");
  assert.equal(readState("config").revoked, true); assert.equal(f.accepted.length, count);
  const revoked = f.requests.length;
  current = await f.launch(); await until(current.idle); assert.equal(f.requests.length, revoked);
});

test("transient startup outage retries without foreground authority or a new pairing", { skip: !available, timeout: 15000 }, async (t) => {
  const f = await fixture(t); f.seed(); f.outage(true);
  const current = await f.launch(); await until(() => f.requests.length >= 3);
  assert.equal(f.accepted.length, 0); assert.equal(readState("config").revoked, false);
  assert.equal(current.idle(), false); assert.equal(current.controller.status().online, false);
  f.outage(false); await until(() => f.accepted.length >= 2);
  assert.equal(current.controller.status().deviceId, undefined);
  assert.equal(f.requests.some((route) => route.includes("pairing")), false);
});

test("pause, old configs and unfinished or expired approvals never acquire startup access", { skip: !available, timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  for (const overrides of [{ paused: true }, { revoked: true }, { resume_on_startup: undefined },
    { resume_on_startup: false }, { api: "https://other.invalid" }, { device_id: "mismatched" }, { device_token: "bad" }]) {
    f.seed(overrides); const current = await f.launch(); await until(current.idle);
    assert.equal(current.runtime.running(), false); assert.equal(f.requests.length, 0);
  }
  f.seed();
  writeState("embedded-pairing", { pairing_id: "expired", deviceId: DEVICE, device_token: TOKEN, expiresAt: Date.now() - 1 });
  const current = await f.launch(); await until(current.idle);
  assert.equal(f.requests.length, 0); assert.equal(readState("embedded-pairing"), null); assert.equal(readState("config"), null);
});

test("logout, failed verification, account switch and membership removal persist startup suspension", { skip: !available, timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  for (const account of [
    { userId: null, deviceIds: [], verified: false },
    { userId: "owner-a", deviceIds: [DEVICE], verified: false },
    { userId: "owner-b", deviceIds: [DEVICE], verified: true },
    { userId: "owner-a", deviceIds: [], verified: true },
  ]) {
    f.seed(); const before = f.accepted.length, current = await f.launch();
    await until(() => f.accepted.length > before);
    await current.controller.updateAccount(account);
    assert.equal(current.runtime.running(), false); assert.equal(readState("config").resume_on_startup, false);
    assert.equal(readState("config").paused, false);
    await current.host.dispose();
    const stopped = f.requests.length, reopened = await f.launch(); await until(reopened.idle);
    assert.equal(f.requests.length, stopped); assert.equal(reopened.runtime.running(), false);
  }
  // Existing explicit reopen consent still works after a fresh account check.
  const current = await f.launch();
  await current.controller.updateAccount({ userId: "owner-a", deviceIds: [DEVICE], verified: true });
  if (current.runtime.pid()) f.pids.add(current.runtime.pid());
  await until(() => current.controller.status().online);
  assert.equal(readState("config").resume_on_startup, true);
  await current.controller.disconnect();
  assert.equal(readState("config").paused, true);
  await current.host.dispose();
  const count = f.requests.length, paused = await f.launch(); await until(paused.idle); assert.equal(f.requests.length, count);
});
