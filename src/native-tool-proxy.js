"use strict";

const { createHash } = require("node:crypto");

const MAX_ARGUMENT_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_PENDING = 8;
const MAX_OPERATIONS = 64;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const supportsToolProxy = (platform = process.platform) => ["darwin", "linux"].includes(platform);
const expires = value => typeof value === "number" ? value * 1000 : Date.parse(value);
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const capability = { type: "string", minLength: 1, maxLength: 160 };
const operation = { type: "string", format: "uuid" };
const DEFINITIONS = [
  { name: "shapes_discover", description: "Discover currently authorized shapes.inc tools for connected apps, browser actions and documents (docs). Availability does not grant permission to act.",
    inputSchema: schema({ query: { type: "string", maxLength: 256 }, cursor: { type: "string", maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 20 } }) },
  { name: "shapes_describe", description: "Read a capability's exact current input contract before calling it.",
    inputSchema: schema({ capability_id: capability }, ["capability_id"]) },
  { name: "shapes_call", description: "Call a described capability. Returns an operation receipt. If running or outcome_unknown, use shapes_read_operation before repeating an action.",
    inputSchema: schema({ capability_id: capability, schema_revision: { type: "string", pattern: "^[a-f0-9]{64}$" }, arguments: { type: "object" } }, ["capability_id", "schema_revision", "arguments"]) },
  { name: "shapes_read_operation", description: "Read a durable operation receipt. Omit operation_id to list recent receipts in this authorized session after a lost response or restart; do not repeat an unconfirmed action.",
    inputSchema: schema({ operation_id: operation, cursor: { type: "string", maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 20 } }) },
  { name: "shapes_cancel_operation", description: "Request cancellation of a previous operation. Cancellation does not undo an action already delivered.",
    inputSchema: schema({ operation_id: operation }, ["operation_id"]) },
];
const ACTIONS = { shapes_discover: "discover", shapes_describe: "describe", shapes_call: "call", shapes_read_operation: "read", shapes_cancel_operation: "cancel" };

// This validates transport binding only. The backend authenticates the separate
// tool audience and freshly authorizes each capability. No model field selects
// an account, payer, destination endpoint or credential.
function validateToolProxy(gateway, { platform = process.platform } = {}) {
  if (gateway.tool_proxy === undefined) return {};
  if (!supportsToolProxy(platform)) throw new Error("Connected native capabilities are unavailable on this platform.");
  const grant = gateway.tool_proxy;
  if (!object(grant) || grant.version !== 1
      || Object.keys(grant).some(key => !["version", "base_url", "token", "expires_at", "session_id", "scope_id", "request_key", "run_id"].includes(key))
      || typeof grant.token !== "string" || !grant.token || grant.token.length > 16384 || /\s/.test(grant.token)
      || grant.token === gateway.token
      || !Number.isFinite(expires(grant.expires_at)) || expires(grant.expires_at) <= Date.now()
      || expires(grant.expires_at) > expires(gateway.expires_at)
      || ["session_id", "scope_id", "request_key", "run_id"].some(key => grant[key] !== gateway[key])) {
    throw new Error("A current tool grant bound to this computer task is required.");
  }
  const url = new URL(grant.base_url), inference = new URL(gateway.base_url);
  if (url.origin !== inference.origin || url.pathname !== "/bridge/native-tools" || url.username || url.password || url.search || url.hash) {
    throw new Error("The tool proxy must use this gateway's fixed native-tools endpoint.");
  }
  const { token, ...metadata } = grant;
  return { toolToken: token, toolProxy: metadata };
}

function operationId(gateway, params) {
  // UUIDv5 in a fixed application namespace. A replay of one native callback
  // keeps its operation identity even if the HTTP response was lost.
  const namespace = Buffer.from("cb08677b82a14cb5a22c6e270ee59979", "hex");
  const bytes = createHash("sha1").update(namespace)
    .update(JSON.stringify([gateway.run_id, params.threadId, params.turnId, params.callId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function failure(error_type, error, operation_id) {
  return { success: false, error_type, error, retryable: false,
    ...(operation_id ? { result: { operation_id, status: "outcome_unknown" } } : {}) };
}
function reply(value) { return { contentItems: [{ type: "inputText", text: JSON.stringify(value) }], success: value.success === true }; }
function validArguments(action, args) {
  if (!object(args) || Buffer.byteLength(JSON.stringify(args)) > MAX_ARGUMENT_BYTES) return false;
  const fields = { discover: ["query", "cursor", "limit"], describe: ["capability_id"], call: ["capability_id", "schema_revision", "arguments"], read: ["operation_id", "cursor", "limit"], cancel: ["operation_id"] }[action];
  if (!fields || Object.keys(args).some(key => !fields.includes(key))) return false;
  if (action === "discover") return [["query", 256], ["cursor", 500]].every(([key, max]) => args[key] === undefined || (typeof args[key] === "string" && args[key].length <= max))
    && (args.limit === undefined || (Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 20));
  if (action === "read" && args.operation_id === undefined) return (args.cursor === undefined || (typeof args.cursor === "string" && args.cursor.length <= 500))
    && (args.limit === undefined || (Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 20));
  if (action === "read" || action === "cancel") return UUID.test(args.operation_id || "") && args.cursor === undefined && args.limit === undefined;
  return typeof args.capability_id === "string" && args.capability_id.length > 0 && args.capability_id.length <= 160
    && (action !== "call" || (object(args.arguments) && /^[a-f0-9]{64}$/.test(args.schema_revision || "")));
}

async function responseJson(response) {
  if (!response.body || !/application\/json/i.test(response.headers.get("content-type") || "")) throw new Error("Invalid tool response.");
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESULT_BYTES) throw Object.assign(new Error("Tool response exceeds its limit."), { code: "tool_result_too_large" });
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!object(value) || typeof value.success !== "boolean" || (value.success && !object(value.result))
      || (!response.ok && value.success)) throw new Error("Invalid tool receipt.");
  return value;
}

function createNativeToolProxy({ gateway, token, getContext, fetchImpl = fetch, timeoutMs = 15000, cleanupTimeoutMs = 2000, platform = process.platform } = {}) {
  const grant = gateway?.tool_proxy;
  const enabled = supportsToolProxy(platform) && object(grant) && typeof token === "string" && token.length > 0;
  const pending = new Map(), operations = new Map();
  let closed = false, closing;
  const current = () => enabled && !closed && expires(grant.expires_at) > Date.now();
  const safeReply = value => {
    const result = reply(value);
    for (const secret of [token, process.env.SHAPES_RUNTIME_TOKEN].filter(Boolean)) {
      result.contentItems[0].text = result.contentItems[0].text.split(secret).join("[redacted]");
    }
    return result;
  };

  async function post(action, args, params, controller, deadline = timeoutMs) {
    const timer = setTimeout(() => controller.abort(), deadline);
    try {
      const response = await fetchImpl(`${grant.base_url}/${action}`, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ session_id: gateway.session_id, scope_id: gateway.scope_id,
          request_key: gateway.request_key, run_id: gateway.run_id,
          native_thread_id: params.threadId, native_turn_id: params.turnId, native_call_id: params.callId, arguments: args }),
      });
      return await responseJson(response);
    } finally { clearTimeout(timer); }
  }

  async function handle(native) {
    const params = native.params || {}, action = ACTIONS[params.tool], context = getContext?.();
    if (!current()) return reply(failure("tool_proxy_unavailable", "Connected capabilities are unavailable for this task."));
    if (native.method !== "item/tool/call" || params.namespace != null || !action
        || !context?.threadId || !context?.turnId || params.threadId !== context.threadId || params.turnId !== context.turnId
        || typeof params.callId !== "string" || !params.callId || params.callId.length > 200
        || !validArguments(action, params.arguments)) return reply(failure("invalid_tool_request", "This tool request does not match the active task or input contract."));
    if (pending.size >= MAX_PENDING || pending.has(native.id)) return reply(failure("tool_proxy_busy", "Too many connected operations are pending. Read existing receipts first."));
    const args = { ...params.arguments }, id = action === "call" ? operationId(gateway, params) : args.operation_id;
    if (action === "call") {
      if (!operations.has(id) && operations.size >= MAX_OPERATIONS) return reply(failure("tool_operation_limit", "This task has reached its connected operation limit."));
      args.operation_id = id;
      operations.set(id, params);
    }
    const controller = new AbortController();
    pending.set(native.id, { controller, params, operation_id: action === "call" ? id : undefined });
    try {
      const value = await post(action, args, params, controller);
      if (["call", "read", "cancel"].includes(action) && id) {
        if (value.success && (value.result.operation_id !== id || ![...TERMINAL, "running", "outcome_unknown"].includes(value.result.status))) throw new Error("Mismatched operation receipt.");
        if (value.result?.operation_id === id && TERMINAL.has(value.result.status)) operations.delete(id);
        else if (!value.success) value.result = { operation_id: id, status: "outcome_unknown" };
      }
      if (action === "read" && !id && value.success && (!Array.isArray(value.result.operations) || value.result.operations.length > 20
          || value.result.operations.some(item => !object(item) || !UUID.test(item.operation_id || "") || ![...TERMINAL, "running", "outcome_unknown"].includes(item.status))
          || (value.result.next_cursor != null && (typeof value.result.next_cursor !== "string" || value.result.next_cursor.length > 500)))) throw new Error("Invalid operation listing.");
      if (!value.success) value.retryable = false;
      return safeReply(value);
    } catch (error) {
      return safeReply(failure(error.code === "tool_result_too_large" ? error.code : "tool_outcome_unknown",
        error.code === "tool_result_too_large" ? "The tool result exceeded the 32 KiB limit. No result was truncated. Read the operation receipt before repeating an action."
          : "The tool service did not confirm the outcome. Read the operation receipt before repeating an action.", id));
    } finally { pending.delete(native.id); }
  }

  async function resolved(id, reason) {
    if (reason === "answered") return;
    const request = pending.get(id);
    if (!request) return;
    request.controller.abort();
    if (request.operation_id && enabled && expires(grant.expires_at) > Date.now()) {
      try { await post("cancel", { operation_id: request.operation_id }, request.params, new AbortController(), cleanupTimeoutMs); } catch { /* Backend closure also fences outstanding operations. */ }
    }
  }
  function close() {
    if (closing) return closing;
    closed = true;
    for (const { controller } of pending.values()) controller.abort();
    // This is best effort. The backend also closes run operations when its
    // native turn closes, including after supervisor death or grant expiry.
    closing = (async () => {
      if (!enabled || expires(grant.expires_at) <= Date.now()) return;
      const queue = [...operations.entries()];
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), cleanupTimeoutMs);
      try {
        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
          while (!controller.signal.aborted) {
            const next = queue.shift(); if (!next) return;
            const [operation_id, params] = next;
            try { await post("cancel", { operation_id }, params, controller, cleanupTimeoutMs); } catch { /* An unknown outcome stays unknown. */ }
          }
        }));
      } finally { clearTimeout(timer); }
    })();
    return closing;
  }
  return { definitions: enabled ? structuredClone(DEFINITIONS) : [], runId: gateway?.run_id, handle, resolved, close };
}

module.exports = { createNativeToolProxy, validateToolProxy, supportsToolProxy, operationId, DEFINITIONS, MAX_ARGUMENT_BYTES, MAX_RESULT_BYTES };
