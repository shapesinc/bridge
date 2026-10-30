"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const DEVICE = "11111111-1111-4111-8111-111111111111", SECRET = "b".repeat(43), TOKEN = `sbd_${DEVICE}.${SECRET}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() >= deadline) throw new Error("Runtime fixture timed out"); await sleep(20); }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Real stdio controller, private state files, owned daemon process, HTTP computer
// API and heartbeat requests. Only remote pairing/tunnel/OS services are fixtures;
// this does not install a background service or make provider/permission calls.
test("durable host detach retains the live daemon and heartbeat until disconnect or account change", { timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-detach-runtime-"));
  const heartbeats = [], offline = [], cancelled = [], pending = new Map(), pids = new Set();
  const backend = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    let result = {};
    if (request.url === "/bridge/pairings") result = { pairing_id: "pair-1", device_code: SECRET, user_code: "ABCD-1234", expires_in: 600, verification_uri_complete: "http://127.0.0.1/approve" };
    else if (request.url === "/bridge/pairings/poll") result = { status: "approved", owner_user_id: "owner-a", device_id: DEVICE, device_token: TOKEN };
    else if (request.url === "/bridge/pairings/cancel") { cancelled.push(body); result = { status: "cancelled" }; }
    else if (["/bridge/devices/heartbeat", "/bridge/devices/offline"].includes(request.url)) {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.writeHead(401); response.end("{}"); return; }
      (request.url.endsWith("heartbeat") ? heartbeats : offline).push(body);
    } else { response.writeHead(404); response.end("{}"); return; }
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
  });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const api = `http://127.0.0.1:${backend.address().port}`;
  const source = path.resolve(__dirname, "../src");
  const daemonCode = `
    const {EventEmitter}=require('node:events');
    const {runDaemon,enablePrivateLog}=require(${JSON.stringify(path.join(source, "runtime"))});
    const parent=require(${JSON.stringify(path.join(source, "embedded-lifetime"))}).parentLifetime();
    enablePrivateLog();
    runDaemon({signal:parent.signal,heartbeatMs:40,retryMs:5,disableStartup(){},
      permissions:async()=>({accessibility:'unknown'}),requestNativePermissions:async()=>{},
      awakeFactory:()=>({status:()=> 'disabled',stop(){}}),
      tunnelFactory:async({port})=>{const child=new EventEmitter();child.exitCode=null;
        child.kill=()=>{child.exitCode=0;child.emit('exit',0)};
        return {child,url:'http://127.0.0.1:'+port}}})
      .then(()=>{parent.dispose();process.exit(0)},()=>process.exit(1));`;
  const hostCode = `
    const {spawn}=require('node:child_process');
    const {createEmbeddedProcess}=require(${JSON.stringify(path.join(source, "embedded-process"))});
    const {createEmbeddedController}=require(${JSON.stringify(path.join(source, "embedded"))});
    const {serveEmbeddedProtocol}=require(${JSON.stringify(path.join(source, "embedded-protocol"))});
    const runtime=createEmbeddedProcess({graceMs:500,spawnProcess:(file,args,options)=>spawn(file,['-e',${JSON.stringify(daemonCode)}],options)});
    serveEmbeddedProtocol({input:process.stdin,output:process.stdout,
      controller:createEmbeddedController({api:${JSON.stringify(api)},runtime,readinessMs:3000}),onClose:code=>process.exit(code)});`;
  const host = spawn(process.execPath, ["-e", hostCode], { env: { ...process.env, SHAPES_BRIDGE_HOME: directory }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(host, "exit");
  let buffer = "", stderr = "", sequence = 0;
  host.stderr.on("data", (chunk) => { stderr += chunk; });
  host.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const reply = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      const callback = pending.get(reply.id); pending.delete(reply.id);
      if (reply.error) callback?.reject(Object.assign(new Error(reply.error.code), reply.error)); else callback?.resolve(reply.result);
    }
  });
  function request(operation, params = {}) {
    const id = `request-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`No reply to ${operation}`)); }, 5000);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      host.stdin.write(JSON.stringify({ version: 1, id, operation, params }) + "\n");
    });
  }
  const read = (name) => JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), "utf8"));
  const account = (userId = "owner-a") => request("updateAccount", { userId, deviceIds: userId === "owner-a" ? [DEVICE] : [], verified: true });
  async function connect(attemptId) {
    await request("beginConnect", { attemptId, expectedUserId: "owner-a" });
    const connected = await request("completeConnect", { attemptId });
    assert.equal(connected.online, true); pids.add(read("status").pid);
  }
  try {
    await account();
    await request("beginConnect", { attemptId: "cancelled-setup", expectedUserId: "owner-a" });
    assert.equal((await request("detach")).state, "disconnected");
    assert.equal(cancelled.length, 1); assert.equal(heartbeats.length, 0);
    assert.equal(fs.existsSync(path.join(directory, "embedded-pairing.json")), false);
    await assert.rejects(request("completeConnect", { attemptId: "cancelled-setup" }), { code: "attempt_not_found" });
    await connect("initial");
    const first = read("status"), count = heartbeats.length;
    assert.equal((await request("detach")).online, true);
    assert.equal((await request("detach")).online, true);
    await until(() => heartbeats.length >= count + 2);
    assert.equal(read("status").pid, first.pid); assert.equal(alive(first.pid), true);
    assert.notEqual(read("status").last_heartbeat, first.last_heartbeat);
    assert.equal(read("config").paused, false); assert.equal(cancelled.length, 1);
    const endpoint = heartbeats.at(-1);
    const health = await fetch(`${endpoint.bridge_url}/sysinfo`, { headers: { "x-token": endpoint.token } });
    assert.equal(health.status, 200); await health.json();

    assert.equal((await request("disconnect")).state, "paused");
    await until(() => !alive(first.pid));
    assert.equal(read("config").paused, true); assert.equal(offline.length, 1);
    assert.equal((await account()).state, "paused");
    assert.equal((await request("detach")).state, "paused");

    await connect("resume"); await request("detach");
    const second = read("status"); assert.notEqual(second.pid, first.pid);
    assert.equal((await account("owner-b")).deviceId, undefined);
    await until(() => !alive(second.pid)); assert.equal(offline.length, 2);
    assert.equal(cancelled.length, 1);

    await account();
    await until(() => fs.existsSync(path.join(directory, "status.json")) && read("status").connection === "connected"); pids.add(read("status").pid);
    const finalPID = read("status").pid;
    host.stdin.end(); assert.deepEqual(await exited, [0, null]);
    await until(() => !alive(finalPID)); assert.equal(stderr, "");
    assert.equal(offline.length, 3);
  } finally {
    host.stdin.end();
    if (host.exitCode === null && host.signalCode === null) {
      await Promise.race([exited, sleep(1500)]);
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    }
    for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    backend.closeAllConnections(); await new Promise((resolve) => backend.close(resolve));
    await until(() => [...pids].every((pid) => !alive(pid)));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
