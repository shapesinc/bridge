"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), Module = require("node:module");
const { randomUUID } = require("node:crypto");

// Actual supervisor and durable files; injected RPC/broker outcomes simulate a
// locked private credential and native close failure without running a model.
async function scenario(t, { cancel = false, processRejects = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-cleanup-fixture-")), previous = process.env.SHAPES_CODEX_JOB_DIR;
  process.env.SHAPES_CODEX_JOB_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.SHAPES_CODEX_JOB_DIR; else process.env.SHAPES_CODEX_JOB_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const id = randomUUID(), directory = path.join(root, id); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify({ id, agent: "codex", sessionId: randomUUID(), status: "queued" }));
  fs.writeFileSync(path.join(directory, "request.json"), JSON.stringify({ agent: "codex", interactive: true, executable: process.execPath, cwd: root, timeout: 5, gateway: {}, prompt: "synthetic" }));
  let closed = 0, transportClosed = 0, complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const mocks = {
    "./native-tool-proxy": { createNativeToolProxy: () => ({ definitions: [{}] }) },
    "./native-tool-broker": { createToolBroker: async () => ({ directory, launchArgs: [], close: async () => { transportClosed++; throw Object.assign(Error("private details must not persist"), { code: "EPERM" }); } }) },
    "./bundled-runtime": { launchConfiguration: () => ({ launchArgs: [] }) },
    "./codex-rpc": { createCodexRpcSession: () => ({ child: { pid: process.pid }, start() {
      if (cancel) { fs.writeFileSync(path.join(directory, "cancel"), "cancel\n"); return completion; }
      return Promise.resolve({ status: "completed", exitCode: 0 });
    }, async close() { closed++; complete({ status: "cancelled", exitCode: 0 }); if (processRejects) throw Error("fixture close failed"); return { processExited: true }; } }) },
  };
  const filename = path.resolve(__dirname, "../src/codex.js"), runtime = new Module(filename), ordinary = Module.createRequire(filename);
  runtime.filename = filename; runtime.paths = Module._nodeModulePaths(path.dirname(filename));
  runtime.require = name => Object.hasOwn(mocks, name) ? mocks[name] : ordinary(name);
  runtime._compile(fs.readFileSync(filename, "utf8"), filename);
  await runtime.exports.supervise(id);
  const state = JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8"));
  assert.equal(closed, 1); assert.equal(transportClosed, 1); assert.equal(state.status, "failed"); assert.ok(state.finishedAt);
  assert.equal(state.errorType, processRejects ? "process_exit_unconfirmed" : "tool_transport_cleanup_unconfirmed");
  assert.equal(JSON.stringify(state).includes("private details"), false);
  const events = fs.readFileSync(path.join(directory, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.at(-1), { type: "job.finished", state: "failed" });
}

test("broker disposal failure still closes native runtime and persists a truthful terminal receipt", { timeout: 5000 }, t => scenario(t));
test("cancellation observes both independent cleanup failures without unhandled rejection or false cancellation", { timeout: 5000 }, t => scenario(t, { cancel: true, processRejects: true }));
