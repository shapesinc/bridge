"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { spawn } = require("node:child_process");
const { createNativeToolProxy, operationId } = require("../src/native-tool-proxy");
const { createToolBroker } = require("../src/native-tool-broker");

test("actual stdio frontend preserves native metadata, rejects extra tools, handles cancellation and removes its private broker", { skip: process.platform === "win32" ? "The native tool broker uses Unix sockets on macOS/Linux" : false }, async t => {
  const calls = [], gateway = { session_id: "session", scope_id: "scope", request_key: "request", run_id: "run",
    tool_proxy: { base_url: "https://example.invalid/bridge/native-tools", expires_at: Date.now() / 1000 + 600 } };
  const proxy = createNativeToolProxy({ gateway, token: "private-tool-grant", getContext: () => ({ threadId: "native-thread", turnId: "native-turn" }), cleanupTimeoutMs: 50,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, body });
      if (url.endsWith("/call")) return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true }));
      return new Response(JSON.stringify({ success: true, result: url.endsWith("/cancel") ? { operation_id: body.arguments.operation_id, status: "cancelled" } : { capabilities: [] } }), { headers: { "content-type": "application/json" } });
    } });
  const broker = await createToolBroker(proxy), config = Object.fromEntries(broker.launchArgs.filter(value => value !== "-c").map(value => [value.slice(0, value.indexOf("=")), JSON.parse(value.slice(value.indexOf("=") + 1))]));
  const socketPath = config["mcp_servers.shapes.args"][1], directory = path.dirname(socketPath);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700); assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  assert.equal(config["mcp_servers.shapes.default_tools_approval_mode"], undefined);
  assert.equal(config["mcp_servers.shapes.enabled_tools"].length, 5);
  assert.equal(Object.keys(config).filter(key => key.endsWith(".approval_mode")).length, 5);
  assert.equal(config["mcp_servers.shapes.tools.unreviewed_tool.approval_mode"], undefined);
  assert.equal(config["mcp_servers.shapes.required"], true);
  assert.equal(broker.launchArgs.join(" ").includes("private-tool-grant"), false);
  const child = spawn(process.execPath, config["mcp_servers.shapes.args"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => { child.stdin.end(); await broker.close(); if (child.exitCode === null) child.kill(); assert.equal(fs.existsSync(directory), false); });
  let buffer = ""; const waiting = new Map(), output = [];
  child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => {
    buffer += chunk; let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); output.push(message);
      const pending = waiting.get(message.id); if (pending) { waiting.delete(message.id); clearTimeout(pending.timer); pending.resolve(message); }
    }
  });
  function send(message) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
  function rpc(id, method, params = {}) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error("MCP fixture timed out")), 1000); waiting.set(id, { resolve, timer }); send({ id, method, params }); }); }
  assert.equal((await rpc(1, "initialize", { protocolVersion: "2025-03-26" })).result.protocolVersion, "2025-03-26");
  assert.equal((await rpc(2, "tools/list")).result.tools.length, 5);
  const meta = { callId: "native-call-1", threadId: "native-thread", "x-codex-turn-metadata": { turn_id: "native-turn" } };
  const ok = await rpc(3, "tools/call", { name: "shapes_discover", arguments: {}, _meta: meta });
  assert.equal(ok.result.isError, false); assert.equal(calls[0].body.native_call_id, "native-call-1");
  assert.equal((await rpc(4, "tools/call", { name: "unreviewed_tool", arguments: {}, _meta: meta })).result.isError, true);
  assert.equal((await rpc(5, "tools/call", { name: "shapes_discover", arguments: {}, _meta: { ...meta, threadId: "other" } })).result.isError, true);
  assert.equal(calls.length, 1);
  send({ id: 6, method: "tools/call", params: { name: "shapes_call", arguments: { capability_id: "fixture", schema_revision: "a".repeat(64), arguments: {} }, _meta: { ...meta, callId: "native-call-2" } } });
  for (let count = 0; count < 100 && calls.length < 2; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls.length, 2);
  send({ method: "notifications/cancelled", params: { requestId: 6 } });
  for (let count = 0; count < 100 && calls.length < 3; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls[2].url.endsWith("/cancel"), true);
  assert.equal(calls[2].body.arguments.operation_id, calls[1].body.arguments.operation_id);
  assert.equal(output.some(message => message.id === 6), false, "Cancelled MCP request has no late response");
  await broker.close();
  assert.equal(fs.existsSync(directory), false);
});

test("broker disconnect returns the precomputed durable operation ID and the MCP process exits", { skip: process.platform === "win32" ? "The native tool broker uses Unix sockets on macOS/Linux" : false }, async t => {
  const net = require("node:net"), directory = fs.mkdtempSync("/tmp/shapes-mcp-loss-"), socketPath = path.join(directory, "socket");
  const server = net.createServer(socket => socket.on("data", () => socket.destroy()));
  await new Promise(resolve => server.listen(socketPath, resolve));
  const run_id = "test-run", params = { threadId: "native-thread", turnId: "native-turn", callId: "native-call" };
  const child = spawn(process.execPath, [path.join(__dirname, "../src/native-tool-mcp.js"), socketPath, run_id], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => { child.stdin.end(); if (child.exitCode === null) child.kill(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const lines = []; let buffer = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { buffer += chunk; let index; while ((index = buffer.indexOf("\n")) >= 0) { lines.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "shapes_call", arguments: { capability_id: "fixture", schema_revision: "a".repeat(64), arguments: {} },
    _meta: { threadId: params.threadId, callId: params.callId, "x-codex-turn-metadata": { turn_id: params.turnId } } } }) + "\n");
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error("MCP process did not exit after broker loss")), 1000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
  const receipt = JSON.parse(lines[0].result.content[0].text);
  assert.equal(lines[0].result.isError, true); assert.equal(receipt.retryable, false);
  assert.deepEqual(receipt.result, { operation_id: operationId({ run_id }, params), status: "outcome_unknown" });
  assert.equal(lines.length, 1);
});
