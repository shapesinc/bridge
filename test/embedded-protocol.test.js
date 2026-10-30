"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseRequest, serveEmbeddedProtocol, MAX_REQUEST_BYTES } = require("../src/embedded-protocol");
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("protocol rejects executable/path/API overrides, unknown fields and unbounded input", () => {
  const base = { version: 1, id: "request-1", operation: "status", params: {} };
  assert.deepEqual(parseRequest(JSON.stringify(base)), base);
  for (const change of [{ operation: "dispose" }, { params: { api: "https://other.example" } }, { extra: true }, { params: [] }, { id: "\nsecret" }, { version: 2 }]) {
    assert.throws(() => parseRequest(JSON.stringify({ ...base, ...change })), { code: "invalid_request" });
  }
  assert.throws(() => parseRequest("x".repeat(MAX_REQUEST_BYTES + 1)), { code: "invalid_request" });
});

test("private stdio returns fixed errors, contains no diagnostics, and disposes on EOF", async () => {
  const input = new PassThrough(), output = new PassThrough(); let text = "", disposed = false, closed = false;
  output.on("data", (part) => { text += part; });
  serveEmbeddedProtocol({ input, output, controller: { status() { throw new Error("secret-token /private/home"); }, async dispose() { disposed = true; } }, onClose() { closed = true; } });
  input.write(JSON.stringify({ version: 1, id: "r", operation: "status", params: {} }) + "\n"); await tick();
  const value = JSON.parse(text); assert.equal(value.error.code, "connection_failed"); assert.equal(text.includes("secret"), false);
  input.end(); await tick(); assert.equal(disposed, true); assert.equal(closed, true);
});

test("oversized partial line closes the controller before any operation", async () => {
  const input = new PassThrough(), output = new PassThrough(); let calls = 0, disposed = false;
  serveEmbeddedProtocol({ input, output, controller: { status() { calls++; }, async dispose() { disposed = true; } } });
  input.write(Buffer.alloc(MAX_REQUEST_BYTES, 65)); input.write("A"); await tick();
  assert.equal(calls, 0); assert.equal(disposed, true);
});

test("actual embedded entry status/signout/EOF creates only its private directory and no runtime", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-embedded-stdio-"));
  const child = spawn(process.execPath, [path.join(__dirname, "../bin/embedded.js")], { env: { ...process.env, SHAPES_BRIDGE_HOME: directory }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", stderr = "";
  child.stdout.on("data", (part) => { output += part; }); child.stderr.on("data", (part) => { stderr += part; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end(JSON.stringify({ version: 1, id: "status", operation: "status", params: {} }) + "\n");
  try {
    assert.equal(await exited, 0); assert.equal(stderr, "");
    const reply = JSON.parse(output); assert.equal(reply.result.state, "disconnected"); assert.equal(reply.result.online, false);
    assert.deepEqual(fs.readdirSync(directory), []); assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  } finally { child.kill(); fs.rmSync(directory, { recursive: true, force: true }); }
});
