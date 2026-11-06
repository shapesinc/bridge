"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { serviceDefinition } = require("../src/service");

test("a real Linux service restart preserves its independently supervised command", {
  skip: process.platform !== "linux" || process.env.SHAPES_TEST_SYSTEMD !== "1", timeout: 45000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-systemd-"));
  const unit = `shapes-bridge-test-${process.pid}.service`;
  const unitFile = path.join(dir, unit), ready = path.join(dir, "ready.json");
  const marker = path.join(dir, "once.txt"), started = path.join(dir, "started.txt");
  const serverScript = path.join(dir, "server.js"), taskScript = path.join(dir, "task.js");
  const scope = "a".repeat(64), key = "b".repeat(64);
  let commandId;
  const ctl = (...args) => {
    const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  };
  const waitFor = async (check) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for service/command readiness");
  };
  fs.writeFileSync(serverScript, `
    require(${JSON.stringify(path.join(__dirname, "../src/server"))}).startServer({port: 0, token: 'test-token'}).then(server => {
      require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid: process.pid, port: server.address().port}));
    });
  `);
  fs.writeFileSync(taskScript, `
    require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started');
    setTimeout(() => { require('node:fs').appendFileSync(${JSON.stringify(marker)}, '1'); console.log('survived restart'); }, 4000);
  `);
  const definition = serviceDefinition({ platform: "linux", dir, home: dir });
  // Run the real HTTP implementation without a tunnel or production pairing.
  fs.writeFileSync(unitFile, definition.content.replace(/^ExecStart=.*$/m,
    `ExecStart="${process.execPath}" "${serverScript}"`));
  const request = async (base, route, body) => {
    const response = await fetch(base + route, { method: body ? "POST" : "GET",
      headers: { "x-token": "test-token", "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  try {
    ctl("link", unitFile);
    ctl("start", unit);
    const first = await waitFor(() => fs.existsSync(ready) && JSON.parse(fs.readFileSync(ready)));
    const body = { cmd: `'${process.execPath}' '${taskScript}'`, timeout: 15, scope, request_key: key };
    const start = await request(`http://127.0.0.1:${first.port}`, "/commands/start", body);
    assert.equal(start.status, 202, JSON.stringify(start));
    commandId = start.body.job_id;
    await waitFor(() => fs.existsSync(started));
    fs.unlinkSync(ready);
    ctl("restart", unit);
    const second = await waitFor(() => fs.existsSync(ready) && JSON.parse(fs.readFileSync(ready)));
    assert.notEqual(second.pid, first.pid);
    const base = `http://127.0.0.1:${second.port}`;
    const final = await request(base, `/commands/status?job_id=${commandId}&scope=${scope}`);
    assert.equal(final.body.state, "completed", JSON.stringify(final));
    assert.equal(final.body.exit_code, 0);
    assert.equal(fs.readFileSync(marker, "utf8"), "1");
    const duplicate = await request(base, "/commands/start", body);
    assert.equal(duplicate.body.deduplicated, true);
    assert.equal(fs.readFileSync(marker, "utf8"), "1");

    fs.writeFileSync(taskScript, "setInterval(() => {}, 1000)");
    const long = await request(base, "/commands/start", { ...body, request_key: "c".repeat(64) });
    commandId = long.body.job_id;
    const cancel = await request(base, "/commands/cancel", { job_id: commandId, scope });
    assert.equal(cancel.body.cancel_requested, true);
    const cancelled = await request(base, `/commands/status?job_id=${commandId}&scope=${scope}`);
    assert.equal(cancelled.body.state, "cancelled", JSON.stringify(cancelled));
  } finally {
    spawnSync("systemctl", ["--user", "stop", unit], { timeout: 10000 });
    if (commandId) spawnSync("systemctl", ["--user", "stop", `shapes-bridge-command-${commandId}.scope`], { timeout: 10000 });
    spawnSync("systemctl", ["--user", "disable", unit], { timeout: 10000 });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
