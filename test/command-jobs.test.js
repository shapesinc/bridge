"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../src/server");
const jobs = require("../src/command-jobs");

test("command receipts survive disconnects, deduplicate starts, isolate scopes and cancel", { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-commands-"));
  const previous = process.env.SHAPES_BRIDGE_HOME;
  process.env.SHAPES_BRIDGE_HOME = dir;
  let server, base;
  const scope = "a".repeat(64), key = "b".repeat(64);
  const open = async () => { server = await startServer({ port: 0, token: "test-command-token" }); base = `http://127.0.0.1:${server.address().port}`; };
  const close = async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); };
  const request = async (route, body) => {
    const response = await fetch(base + route, { method: body ? "POST" : "GET", headers: { "x-token": "test-command-token", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const quote = (value) => "'" + value.replace(/'/g, process.platform === "win32" ? "''" : "'\\''") + "'";
  const script = path.join(dir, "task.js"), marker = path.join(dir, "count.txt");
  fs.writeFileSync(script, `setTimeout(()=>{require('fs').appendFileSync(${JSON.stringify(marker)},'1');console.log('receipt-ok')},1200)`);
  const cmd = `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(script)}`;
  try {
    await open();
    assert.equal((await fetch(base + "/commands/start", { method: "POST" })).status, 401);
    const started = await request("/commands/start", { cmd, timeout: 10, scope, request_key: key });
    assert.equal(started.status, 202);
    const id = started.body.job_id;
    assert.match(id, /^[a-f0-9]{64}$/);
    const duplicate = await request("/commands/start", { cmd, timeout: 10, scope, request_key: key });
    assert.equal(duplicate.body.job_id, id);
    assert.equal(duplicate.body.deduplicated, true);
    assert.equal((await request("/commands/start", { cmd: cmd + " changed", timeout: 10, scope, request_key: key })).body.error_type, "command_conflict");
    assert.equal((await request("/commands/status?job_id=" + id + "&scope=" + "c".repeat(64))).status, 404);
    assert.equal((await request("/commands/cancel", { job_id: id, scope: "c".repeat(64) })).status, 404);
    const busy = await request("/commands/start", { cmd, timeout: 10, scope: "c".repeat(64), request_key: key });
    assert.equal(busy.body.error_type, "computer_busy");
    assert.equal(busy.body.job_id, undefined);
    for (const [route, body] of [
      ["/run", { cmd }], ["/write", { path: path.join(dir, "conflicting.txt"), content: "wrong run" }],
      ["/open", { target: path.join(dir, "conflicting.txt") }],
    ]) {
      const rejected = await request(route, body);
      assert.equal(rejected.status, 409);
      assert.equal(rejected.body.error_type, "computer_busy");
    }
    assert.equal(fs.existsSync(path.join(dir, "conflicting.txt")), false);
    // Closing/reopening the HTTP server models a lost tunnel/daemon. The
    // independent supervisor finishes once and its receipt remains readable.
    await close();
    await open();
    const completed = await request(`/commands/status?job_id=${id}&scope=${scope}`);
    assert.equal(completed.body.state, "completed", JSON.stringify(completed));
    assert.equal(completed.body.stdout.trim(), "receipt-ok");
    assert.equal(fs.readFileSync(marker, "utf8"), "1");
    assert.ok(completed.body.finished_at >= completed.body.started_at);
    const replay = await request("/commands/start", { cmd, timeout: 10, scope, request_key: key });
    assert.equal(replay.body.state, "completed");
    assert.equal(fs.readFileSync(marker, "utf8"), "1");
    await t.test("cancellation returns an acknowledgement, then a stopped receipt", async () => {
      fs.writeFileSync(script, "setInterval(()=>{},1000)");
      const started = await request("/commands/start", { cmd, timeout: 30, scope, request_key: "d".repeat(64) });
      const id = started.body.job_id;
      const cancelled = await request("/commands/cancel", { job_id: id, scope });
      assert.equal(cancelled.body.cancel_requested, true);
      const final = await request(`/commands/status?job_id=${id}&scope=${scope}`);
      assert.equal(final.body.state, "cancelled", JSON.stringify(final));
      assert.equal(final.body.exit_code, -1);
    });
    await t.test("missing supervisor is reported as uncertain and never replayed", async () => {
      const record = jobs.load(id);
      jobs.save({ ...record, state: "running", created_at: Date.now() - 20000, supervisor_pid: 99999999 });
      const result = jobs.status(id, scope);
      assert.equal(result.state, "interrupted");
      assert.equal(result.outcome_unknown, true);
      assert.equal((await jobs.start({ cmd, timeout: 10, scope, request_key: key })).state, "interrupted");
    });
  } finally {
    if (server?.listening) await close();
    if (previous === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
