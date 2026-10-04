"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRequest, nativeResponse } = require("../src/approvals");

const browser = () => ({ id: 0, method: "mcpServer/elicitation/request", params: {
  mode: "form", message: "Allow access to https://example.org?", serverName: "cua_repl",
  _meta: { connector_id: "browser-use", tool_name: "access_browser_origin", private: "do-not-forward" },
  requestedSchema: { type: "object", properties: {} },
} });

test("native browser consent preserves its message, requires a decision, and never grants persistent policy", () => {
  const request = browser(), display = normalizeRequest(request);
  assert.equal(display.message, request.params.message);
  assert.equal(display.kind, "permission");
  assert.equal(JSON.stringify(display).includes("do-not-forward"), false);
  assert.throws(() => nativeResponse(request, display, {}));
  assert.deepEqual(nativeResponse(request, display, { decision: "accept", values: {} }), { action: "accept", content: {} });
  assert.deepEqual(nativeResponse(request, display, { decision: "decline" }), { action: "decline", content: null });
  assert.throws(() => nativeResponse(request, display, { decision: "accept", _meta: { persist: true } }));
  assert.throws(() => nativeResponse(request, display, { decision: "accept", values: { fake_permission: true } }));
});

test("native questions bind answers to exact IDs and offered options", () => {
  const request = { id: 4, method: "item/tool/requestUserInput", params: { questions: [
    { id: "pickup", question: "Which location?", options: [{ label: "Downtown", description: "Main Street" }] },
    { id: "notes", question: "Any notes?", options: null },
  ] } };
  const display = normalizeRequest(request);
  assert.throws(() => nativeResponse(request, display, { decision: "accept", values: { pickup: "Downtown" } }));
  assert.throws(() => nativeResponse(request, display, { decision: "accept", values: { pickup: "Elsewhere", notes: "None" } }));
  assert.deepEqual(nativeResponse(request, display, { decision: "accept", values: { pickup: "Downtown", notes: "None" } }),
    { answers: { pickup: { answers: ["Downtown"] }, notes: { answers: ["None"] } } });
  request.params.questions[0].isOther = true;
  assert.doesNotThrow(() => nativeResponse(request, normalizeRequest(request), { decision: "accept", values: { pickup: "Home", notes: "None" } }));
});

test("native action approvals show complete consequential arguments or reject the prompt", () => {
  const request = browser();
  request.params._meta.tool_title = "Send order";
  request.params._meta.tool_params = { recipient: "Test recipient", quantity: 2, total: "12.50 USD" };
  const display = normalizeRequest(request);
  assert.ok(display.message.includes(JSON.stringify(request.params._meta.tool_params, null, 2)));
  assert.equal(JSON.stringify(display).includes("do-not-forward"), false);
  request.params._meta.tool_params.extra = "x".repeat(4000);
  assert.throws(() => normalizeRequest(request));
});

test("MCP form constraints reject widened or missing answers", () => {
  const request = browser();
  request.params.requestedSchema = { type: "object", required: ["count", "size", "extras", "confirm"], properties: {
    count: { type: "integer", minimum: 1, maximum: 3 },
    size: { type: "string", oneOf: [{ const: "small", title: "Small" }] },
    extras: { type: "array", items: { type: "string", enum: ["ice", "milk"] }, minItems: 1, maxItems: 2 },
    confirm: { type: "boolean" },
  } };
  const display = normalizeRequest(request);
  const values = { count: 2, size: "small", extras: ["ice"], confirm: false };
  assert.deepEqual(nativeResponse(request, display, { decision: "accept", values }).content, values);
  for (const change of [{ count: 4 }, { count: 1.5 }, { size: "large" }, { extras: [] }, { extras: ["ice", "ice"] }, { confirm: "yes" }]) {
    assert.throws(() => nativeResponse(request, display, { decision: "accept", values: { ...values, ...change } }));
  }
});

test("required MCP strings allow an explicit empty value unless constrained, while native questions need an answer", () => {
  const request = browser();
  request.params.requestedSchema = { type: "object", required: ["notes", "choice"], properties: {
    notes: { type: "string" }, choice: { type: "string", enum: ["", "Other"] },
  } };
  const display = normalizeRequest(request);
  assert.throws(() => nativeResponse(request, display, { decision: "accept", values: {} }));
  assert.deepEqual(nativeResponse(request, display, { decision: "accept", values: { notes: "", choice: "" } }).content, { notes: "", choice: "" });
  request.params.requestedSchema.properties.notes.minLength = 1;
  assert.throws(() => nativeResponse(request, normalizeRequest(request), { decision: "accept", values: { notes: "", choice: "" } }));
  const question = { method: "item/tool/requestUserInput", params: { questions: [{ id: "size", question: "Which size?" }] } };
  assert.throws(() => nativeResponse(question, normalizeRequest(question), { decision: "accept", values: { size: "" } }));
});

test("unsupported verification, schemas, secrets and oversized prompts never become approvable", () => {
  for (const mode of ["openai/userVerification", "url"]) {
    const request = browser(); request.params.mode = mode;
    assert.throws(() => normalizeRequest(request));
  }
  const request = browser();
  request.params.requestedSchema.properties.nested = { type: "object", properties: {} };
  assert.throws(() => normalizeRequest(request));
  request.params.requestedSchema.properties = JSON.parse('{"__proto__":{"type":"string"}}');
  assert.throws(() => normalizeRequest(request));
  request.params.message = "x".repeat(4001);
  assert.throws(() => normalizeRequest(request));
  assert.throws(() => normalizeRequest({ method: "item/tool/requestUserInput", params: { questions: [{ id: "key", question: "Password", isSecret: true }] } }));
});

test("commands offer only native one-time choices and show the exact command", () => {
  const request = { method: "item/commandExecution/requestApproval", params: {
    command: "git status --short", cwd: "/project", reason: "Read repository status", availableDecisions: ["decline", "cancel"],
  } };
  const display = normalizeRequest(request);
  assert.match(display.message, /git status --short/);
  assert.throws(() => nativeResponse(request, display, { decision: "accept" }));
  assert.deepEqual(nativeResponse(request, display, { decision: "decline" }), { decision: "decline" });
});
