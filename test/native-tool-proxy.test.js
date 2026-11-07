"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { createNativeToolProxy: createProxy, validateToolProxy, supportsToolProxy, operationId, MAX_RESULT_BYTES } = require("../src/native-tool-proxy");
const { validateGateway, launchConfiguration } = require("../src/bundled-runtime");
// HTTP/validation tests are platform independent; Unix socket tests are separate.
const createNativeToolProxy = options => createProxy({ platform: "darwin", ...options });

function grant(base = "https://example.invalid") {
  const gateway = { base_url: base + "/v1", token: "inference-secret", model: "gpt-6-astra",
    session_id: randomUUID(), scope_id: "fixture-scope", request_key: "fixture-request-key", run_id: randomUUID(), expires_at: Date.now() / 1000 + 600 };
  gateway.tool_proxy = { version: 1, base_url: base + "/bridge/native-tools", token: "tools-secret",
    ...Object.fromEntries(["session_id", "scope_id", "request_key", "run_id", "expires_at"].map(key => [key, gateway[key]])) };
  return gateway;
}
function native(tool, args = {}, id = 1) {
  return { id, method: "item/tool/call", params: { threadId: "native-thread", turnId: "native-turn", callId: `native-call-${id}`, namespace: null, tool, arguments: args } };
}
const context = () => ({ threadId: "native-thread", turnId: "native-turn" });
const result = value => JSON.parse(value.contentItems[0].text);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("separate tool grant requires exact scope, expiry, origin and fixed endpoint; secrets never persist", () => {
  const gateway = grant(), check = value => validateGateway(value, { sessionId: gateway.session_id, scopeId: gateway.scope_id, requestKey: gateway.request_key, platform: "darwin" });
  const accepted = check(gateway);
  assert.equal(accepted.toolToken, "tools-secret");
  assert.equal(accepted.token, "inference-secret");
  assert.equal(JSON.stringify(accepted.metadata).includes("secret"), false);
  for (const patch of [{ token: gateway.token }, { token: "secret\nheader" }, { version: 2 }, { run_id: randomUUID() }, { scope_id: "other" },
    { expires_at: Date.now() / 1000 - 1 }, { expires_at: gateway.expires_at + 1 }, { base_url: "https://elsewhere.invalid/bridge/native-tools" },
    { base_url: "https://example.invalid/bridge/native-tools?actor=someone" }, { base_url: "https://example.invalid/other" }, { actor_id: "someone" }]) {
    assert.throws(() => check({ ...gateway, tool_proxy: { ...gateway.tool_proxy, ...patch } }));
  }
  assert.deepEqual(validateToolProxy({ ...gateway, tool_proxy: undefined }), {});
});

test("default off and expired grants deny stale callbacks without transport or extra schemas", async () => {
  let requests = 0;
  for (const options of [{}, { gateway: grant(), token: undefined }, { gateway: { ...grant(), tool_proxy: { ...grant().tool_proxy, expires_at: 1 } }, token: "expired" }]) {
    const proxy = createNativeToolProxy({ ...options, getContext: context, fetchImpl: () => { requests++; throw Error(); } });
    if (!options.token) assert.deepEqual(proxy.definitions, []);
    assert.equal(result(await proxy.handle(native("shapes_discover"))).error_type, "tool_proxy_unavailable");
    await proxy.close();
  }
  assert.equal(requests, 0);
});

test("unsupported platforms cannot advertise or activate the private transport; flag-off remains unchanged", async () => {
  assert.equal(supportsToolProxy("freebsd"), false); assert.equal(supportsToolProxy("darwin"), true); assert.equal(supportsToolProxy("linux"), true);
  const gateway = grant();
  assert.throws(() => validateToolProxy(gateway, { platform: "freebsd" }), /platform/);
  assert.deepEqual(validateToolProxy({ ...gateway, tool_proxy: undefined }, { platform: "win32" }), {});
  const proxy = createNativeToolProxy({ gateway, token: "tools-secret", platform: "freebsd", getContext: context, fetchImpl: () => assert.fail("No unsupported transport") });
  assert.deepEqual(proxy.definitions, []);
  assert.equal(result(await proxy.handle(native("shapes_discover"))).error_type, "tool_proxy_unavailable");
  await proxy.close();
});

test("HTTP capability advertisement reflects the supported platform and executable availability", async t => {
  const { startServer } = require("../src/server");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform"), previous = process.env.SHAPES_BUNDLED_CODEX_BINARY;
  const server = await startServer({ port: 0, token: "synthetic-capability-test" });
  t.after(async () => { Object.defineProperty(process, "platform", descriptor); if (previous === undefined) delete process.env.SHAPES_BUNDLED_CODEX_BINARY; else process.env.SHAPES_BUNDLED_CODEX_BINARY = previous;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const supported = async () => (await (await fetch(`http://127.0.0.1:${server.address().port}/capabilities`)).json()).features.native_tool_proxy;
  process.env.SHAPES_BUNDLED_CODEX_BINARY = process.execPath;
  Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" }); assert.equal(await supported(), true);
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" }); assert.equal(await supported(), true);
  Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
  process.env.SHAPES_BUNDLED_CODEX_BINARY = "/missing/synthetic/codex-app-server"; assert.equal(await supported(), false);
});

test("five primitives use scoped transport and stable callback identity; no caller can inject authority", async () => {
  const gateway = grant(), calls = [];
  const proxy = createNativeToolProxy({ gateway, token: gateway.tool_proxy.token, getContext: context, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body, headers: options.headers, redirect: options.redirect });
    if (url.endsWith("/call")) return json({ success: true, result: { operation_id: body.arguments.operation_id, status: "running" } });
    if (url.endsWith("/read") || url.endsWith("/cancel")) return json({ success: true, result: { operation_id: body.arguments.operation_id, status: "completed", tool_result: { text: "fixture" } } });
    return json({ success: true, result: { capabilities: [] } });
  } });
  assert.equal(proxy.definitions.length, 5);
  assert.equal(proxy.definitions.find(value => value.name === "shapes_discover").inputSchema.properties.query.maxLength, 256);
  assert.equal(proxy.definitions.find(value => value.name === "shapes_describe").inputSchema.properties.capability_id.maxLength, 160);
  assert.equal(proxy.definitions.find(value => value.name === "shapes_call").inputSchema.properties.operation_id, undefined);
  await proxy.handle(native("shapes_discover", { query: "browser", limit: 20 }));
  await proxy.handle(native("shapes_describe", { capability_id: "browser.inspect" }, 2));
  const request = native("shapes_call", { capability_id: "browser.inspect", schema_revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", arguments: { snapshot: "fixture" } }, 3);
  const receipt = result(await proxy.handle(request));
  assert.equal(receipt.result.operation_id, operationId(gateway, request.params));
  await proxy.handle(native("shapes_read_operation", { operation_id: receipt.result.operation_id }, 4));
  await proxy.handle(native("shapes_cancel_operation", { operation_id: receipt.result.operation_id }, 5));
  assert.deepEqual(calls.map(value => value.url.split("/").at(-1)), ["discover", "describe", "call", "read", "cancel"]);
  for (const call of calls) {
    assert.equal(call.headers.authorization, "Bearer tools-secret"); assert.equal(call.redirect, "error");
    assert.equal(call.body.session_id, gateway.session_id); assert.equal(call.body.native_thread_id, "native-thread");
    assert.equal(Object.hasOwn(call.body, "token"), false);
  }
  for (const bad of [native("shapes_discover", { actor_id: "someone" }), native("shapes_call", { capability_id: "a", schema_revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", arguments: {}, operation_id: randomUUID() }),
    native("shapes_discover", { limit: 21 }), native("shapes_discover", { query: "q".repeat(257) }), native("shapes_describe", { capability_id: "c".repeat(161) }),
    native("shapes_call", { capability_id: "c".repeat(161), schema_revision: "a".repeat(64), arguments: {} }),
    native("shapes_call", { capability_id: "a", schema_revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", arguments: { text: "x".repeat(17000) } }),
    { ...request, params: { ...request.params, threadId: "other" } }, { ...request, params: { ...request.params, turnId: "other" } },
    { ...request, params: { ...request.params, namespace: "other" } }, native("unreviewed_tool", {})]) {
    assert.equal(result(await proxy.handle(bad)).error_type, "invalid_tool_request");
  }
  assert.equal(calls.length, 5);
  await proxy.close();
});

test("lost, malformed, wrong-ID, oversized and denied call responses preserve an unknown operation receipt with no retry", async () => {
  for (const outcome of [() => { throw Error("private provider details"); },
    () => new Response("not json", { headers: { "content-type": "text/html" } }),
    () => json({ success: true, result: { operation_id: randomUUID(), status: "completed" } }),
    () => json({ success: true, result: { payload: "x".repeat(MAX_RESULT_BYTES) } }),
    () => json({ success: false, error_type: "unauthorized", error: "Denied", retryable: true }, 403)]) {
    const gateway = grant(), request = native("shapes_call", { capability_id: "fixture", schema_revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", arguments: {} });
    let calls = 0;
    const proxy = createNativeToolProxy({ gateway, token: "tools-secret", getContext: context, fetchImpl: async () => { calls++; return outcome(); } });
    const receipt = result(await proxy.handle(request));
    assert.equal(receipt.success, false); assert.equal(receipt.retryable, false);
    assert.deepEqual(receipt.result, { operation_id: operationId(gateway, request.params), status: "outcome_unknown" });
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(receipt).includes("private provider details"), false);
    await proxy.close();
  }
});

test("tool credentials are removed from runtime environment and responses", async t => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-tools-env-"));
  const keys = ["SHAPES_BRIDGE_HOME", "SHAPES_RUNTIME_TOKEN", "SHAPES_NATIVE_TOOL_TOKEN"], before = keys.map(key => process.env[key]);
  Object.assign(process.env, { SHAPES_BRIDGE_HOME: directory, SHAPES_RUNTIME_TOKEN: "inference-secret", SHAPES_NATIVE_TOOL_TOKEN: "tools-secret" });
  t.after(() => { keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; }); fs.rmSync(directory, { recursive: true, force: true }); });
  const gateway = grant(), config = launchConfiguration(gateway);
  assert.equal(config.environment.SHAPES_NATIVE_TOOL_TOKEN, undefined);
  const proxy = createNativeToolProxy({ gateway, token: "tools-secret", getContext: context,
    fetchImpl: async () => json({ success: true, result: { text: "tools-secret inference-secret" } }) });
  const receipt = await proxy.handle(native("shapes_discover"));
  assert.equal(receipt.contentItems[0].text.includes("secret"), false);
  await proxy.close();
});

test("recent receipt discovery recovers lost IDs and rejects malformed or oversized pages", async () => {
  const gateway = grant(), operation_id = randomUUID(), calls = [];
  let page = { operations: [{ operation_id, status: "completed", capability_id: "fixture" }], next_cursor: "next" };
  const proxy = createNativeToolProxy({ gateway, token: "tools-secret", getContext: context, fetchImpl: async (url, options) => {
    calls.push(JSON.parse(options.body)); return json({ success: true, result: page });
  } });
  assert.deepEqual(result(await proxy.handle(native("shapes_read_operation", {}))).result, page);
  await proxy.handle(native("shapes_read_operation", { cursor: "next", limit: 20 }, 2));
  assert.deepEqual(calls[1].arguments, { cursor: "next", limit: 20 });
  for (const finalPage of [{ operations: [], next_cursor: null }, { operations: [{ operation_id, status: "completed" }], next_cursor: null }]) {
    page = finalPage; assert.deepEqual(result(await proxy.handle(native("shapes_read_operation", {}))).result, finalPage);
  }
  assert.equal(result(await proxy.handle(native("shapes_read_operation", { operation_id, cursor: "next" }, 3))).error_type, "invalid_tool_request");
  for (const invalid of [{ operations: [{ operation_id: "bad", status: "completed" }] }, { operations: Array(21).fill({ operation_id, status: "completed" }) }, { operations: [], next_cursor: 42 }]) {
    page = invalid; assert.equal(result(await proxy.handle(native("shapes_read_operation", {}))).success, false);
  }
  await proxy.close();
});

test("actual HTTP timeout and stop abort a request; 64 hung cleanup operations share one bounded deadline", async t => {
  let calls = 0, cancelled = 0;
  const server = http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (req.url.endsWith("/cancel")) { cancelled++; return; }
    calls++;
    if (body.arguments.capability_id === "hang") return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, result: { operation_id: body.arguments.operation_id, status: "running" } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const gateway = grant(`http://127.0.0.1:${server.address().port}`);
  const proxy = createNativeToolProxy({ gateway, token: "tools-secret", getContext: context, timeoutMs: 60, cleanupTimeoutMs: 100 });
  const unknown = result(await proxy.handle(native("shapes_call", { capability_id: "hang", schema_revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", arguments: {} }, 0)));
  assert.equal(unknown.result.status, "outcome_unknown");
  for (let id = 1; id < 64; id++) await proxy.handle(native("shapes_call", { capability_id: "fixture", schema_revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", arguments: {} }, id));
  assert.equal(result(await proxy.handle(native("shapes_call", { capability_id: "fixture", schema_revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", arguments: {} }, 65))).error_type, "tool_operation_limit");
  const before = Date.now(); await proxy.close();
  assert.ok(Date.now() - before < 600, "Cleanup has one global deadline, not a deadline per operation");
  assert.equal(calls, 64); assert.equal(cancelled, 4);
  assert.equal(result(await proxy.handle(native("shapes_discover"))).error_type, "tool_proxy_unavailable");
});
