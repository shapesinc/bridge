"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const { createAccountRevocation, RECEIPT, ACK } = require("../src/account-revocation");
const { createEmbeddedController } = require("../src/embedded");
const { readState, writeState } = require("../src/state");
const entry = path.resolve(__dirname, "../bin/embedded-state.js");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-account-clear-")), previous = process.env.SHAPES_BRIDGE_HOME;
  process.env.SHAPES_BRIDGE_HOME = dir;
  t.after(() => { if (previous === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function invoke(dir, command) {
  return spawnSync(process.execPath, [entry, command], { env: { ...process.env, SHAPES_BRIDGE_HOME: dir }, encoding: "utf8", timeout: 5000, maxBuffer: 1024 });
}
const parse = result => { assert.equal(result.status, 0, result.stderr); assert.ok(Buffer.byteLength(result.stdout) <= 256); return JSON.parse(result.stdout); };
test("finite installed writer records durable intent without reading/changing credentials or starting a controller", (t) => {
  const dir = directory(t);
  assert.deepEqual(parse(invoke(dir, "read-revocation")), { version: 1, revocationToken: "none" });
  const config = '{"mode":"embedded","device_token":"private-fixture","resume_on_startup":true}\n';
  fs.writeFileSync(path.join(dir, "config.json"), config);
  const recorded = parse(invoke(dir, "record-revocation"));
  assert.match(recorded.revocationToken, /^[a-f0-9-]{36}$/);
  assert.deepEqual(parse(invoke(dir, "read-revocation")), recorded);
  assert.equal(fs.readFileSync(path.join(dir, "config.json"), "utf8"), config);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${RECEIPT}.json`, "config.json"].sort());
  assert.equal(invoke(dir, "launch").status, 1);
});
test("racing writers publish whole bounded receipts; consuming an older clear cannot acknowledge the newer one", async (t) => {
  const dir = directory(t), store = createAccountRevocation();
  const runs = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, [entry, "record-revocation"], { env: { ...process.env, SHAPES_BRIDGE_HOME: dir }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.resume();
    return once(child, "close").then(([code]) => { assert.equal(code, 0); return JSON.parse(output); });
  });
  const records = await Promise.all(runs), latest = store.read();
  assert.equal(new Set(records.map(r => r.revocationToken)).size, 4);
  assert.ok(records.some(r => r.revocationToken === latest.revocationToken));
  let newer;
  await store.consume(async token => { assert.equal(token, latest.revocationToken); newer = store.record(); });
  assert.equal(readState(ACK), null); assert.equal(store.read().pending, true);
  await store.consume(async token => assert.equal(token, newer.revocationToken));
  assert.equal(store.read().pending, false); assert.equal(readState(ACK).revocationToken, newer.revocationToken);
  assert.ok(fs.existsSync(path.join(dir, `${RECEIPT}.json`)), "receipt remains durable after acknowledgement");
});
test("missing, malformed, oversized or failed receipt state cannot become the legacy no-clear token", async (t) => {
  const dir = directory(t), store = createAccountRevocation();
  store.record(); await store.consume(async () => {});
  const file = path.join(dir, `${RECEIPT}.json`);
  for (const contents of [null, "{", " ".repeat(257), JSON.stringify({ version: 1, revocationToken: "none" })]) {
    if (contents === null) fs.rmSync(file); else fs.writeFileSync(file, contents);
    assert.throws(() => store.read());
    assert.throws(() => createAccountRevocation().read(), "persisted ack protects a restarted reader");
    assert.equal(invoke(dir, "read-revocation").status, 1);
  }
  const fresh = store.record(); assert.equal(store.read().revocationToken, fresh.revocationToken);
  fs.rmSync(file); fs.mkdirSync(file);
  assert.equal(invoke(dir, "record-revocation").status, 1);
  assert.throws(() => store.read());
  const failed = createAccountRevocation({ read: () => null, write: () => { throw new Error("disk full"); } });
  assert.throws(() => failed.record(), /disk full/);
});
test("a failed consumer never acknowledges cleanup; a subsequent successful consumer can retry", async (t) => {
  directory(t); const store = createAccountRevocation(); store.record();
  await assert.rejects(store.consume(async () => { throw new Error("stop unknown"); }), /stop unknown/);
  assert.equal(store.read().pending, true); assert.equal(readState(ACK), null);
  await store.consume(async () => {}); assert.equal(store.read().pending, false);
});
test("controller flushes startup denial before acknowledging, including already-false config and flush failure", async () => {
  for (const failFlush of [false, true]) {
    const values = new Map(), writes = [];
    const read = name => values.get(name) ?? null;
    const write = (name, value, options) => {
      writes.push({ name, value, options });
      if (name === "config" && failFlush) throw new Error("config flush failed");
      values.set(name, structuredClone(value));
    };
    values.set("config", { mode: "embedded", resume_on_startup: false, paused: false, device_token: "unchanged" });
    const store = createAccountRevocation({ read, write }); store.record();
    let live = true;
    const controller = createEmbeddedController({ read, write, remove: name => values.delete(name),
      runtime: { running: () => live, pid: () => live ? 123 : null, start: async () => assert.fail("must not start"), stop: async () => { live = false; } } });
    try {
      if (failFlush) await assert.rejects(controller.resumeSavedConnection(), /config flush failed/);
      else await controller.resumeSavedConnection();
      assert.equal(live, false);
      assert.equal(store.read().pending, failFlush);
      const ack = writes.findIndex(entry => entry.name === ACK);
      if (failFlush) assert.equal(ack, -1);
      else {
        assert.ok(ack > 0);
        assert.equal(writes[ack - 1].name, "config");
        assert.equal(writes[ack - 1].options.durable, true);
        assert.equal(writes[ack - 1].value.resume_on_startup, false);
        assert.equal(writes[ack - 1].value.device_token, "unchanged");
      }
    } finally { await controller.dispose(); }
  }
});
test("clear during awaited runtime start fences stale proof and resume writes; fresh proof recovers without unpausing", async (t) => {
  directory(t); const store = createAccountRevocation();
  const device = "11111111-1111-4111-8111-111111111111";
  writeState("config", { mode: "embedded", api: "https://api.shapes.inc", owner_user_id: "owner-a", device_id: device, device_token: `sbd_${device}.${"a".repeat(43)}`, paused: false, resume_on_startup: false });
  let live = false, started, release;
  const entered = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const runtime = { running: () => live, pid: () => live ? 123 : null, start: async () => { live = true; started(); await gate; }, stop: async () => { live = false; } };
  const controller = createEmbeddedController({ runtime, revocationPollMs: 25 }); t.after(() => controller.dispose());
  const proof = { userId: "owner-a", deviceIds: [device], verified: true, revocationToken: "none" };
  const old = controller.updateAccount(proof); await entered;
  const clear = store.record(); release();
  await assert.rejects(old, { code: "account_changed" });
  assert.equal(live, false); assert.equal(readState("config").resume_on_startup, false);
  await assert.rejects(controller.updateAccount(proof), { code: "account_changed" });
  await controller.updateAccount({ ...proof, revocationToken: clear.revocationToken });
  assert.equal(live, true); assert.equal(readState("config").resume_on_startup, true);
  assert.equal(readState("config").device_token, `sbd_${device}.${"a".repeat(43)}`);
  await controller.disconnect(); const next = store.record();
  await controller.updateAccount({ ...proof, revocationToken: next.revocationToken });
  assert.equal(live, false); assert.equal(readState("config").paused, true);
  const writes = fs.statSync(path.join(process.env.SHAPES_BRIDGE_HOME, "config.json")).mtimeMs;
  await controller.dispose(); store.record(); await delay(70);
  assert.equal(fs.statSync(path.join(process.env.SHAPES_BRIDGE_HOME, "config.json")).mtimeMs, writes, "disposed watcher does not mutate state");
});
