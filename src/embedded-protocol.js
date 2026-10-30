"use strict";

const { failure, MESSAGES } = require("./embedded");
const METHODS = Object.freeze({ status: [], beginConnect: ["attemptId", "expectedUserId"], completeConnect: ["attemptId"],
  cancelConnect: ["attemptId"], disconnect: [], requestPermission: ["permission"], updateAccount: ["userId", "deviceIds", "verified"] });
const MAX_REQUEST_BYTES = 16 * 1024;

function parseRequest(line) {
  if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) throw failure("invalid_request");
  let request;
  try { request = JSON.parse(line); } catch { throw failure("invalid_request"); }
  if (!request || Array.isArray(request) || request.version !== 1 || typeof request.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request.id) ||
    Object.keys(request).some((key) => !["version", "id", "operation", "params"].includes(key)) || !Object.hasOwn(METHODS, request.operation)) throw failure("invalid_request");
  const params = request.params ?? {};
  const keys = METHODS[request.operation];
  if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length !== keys.length || keys.some((key) => !Object.hasOwn(params, key))) throw failure("invalid_request");
  return { ...request, params };
}

// A bounded stream (including partial lines) rather than readline's unbounded
// accumulation. stdout contains only sanitized replies to the private host.
function serveEmbeddedProtocol({ input, output, controller, onClose = () => {} }) {
  let buffer = Buffer.alloc(0), closing = false, pending = new Set();
  const activeIds = new Set();
  const respond = (value) => { const line = JSON.stringify(value); if (Buffer.byteLength(line) <= 64 * 1024) output.write(line + "\n"); };
  const reject = (id, error) => { const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : "connection_failed"; respond({ version: 1, id, error: { code, message: MESSAGES[code] } }); };
  async function close() {
    if (closing) return;
    closing = true;
    let code = 0;
    try { await controller.dispose(); await Promise.allSettled([...pending]); }
    catch { code = 1; }
    finally { onClose(code); }
  }
  function line(bytes) {
    let request;
    try { request = parseRequest(bytes.toString("utf8")); }
    catch (error) { reject(null, error); return; }
    if (activeIds.has(request.id) || activeIds.size >= 32) { reject(request.id, failure("invalid_request")); return; }
    activeIds.add(request.id);
    const task = Promise.resolve().then(() => controller[request.operation](request.params))
      .then((result) => respond({ version: 1, id: request.id, result }), (error) => reject(request.id, error))
      .finally(() => { activeIds.delete(request.id); pending.delete(task); });
    pending.add(task);
  }
  input.on("data", (chunk) => {
    if (closing) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0, end;
    while ((end = data.indexOf(10, offset)) !== -1) {
      if (buffer.length + end - offset > MAX_REQUEST_BYTES) { reject(null, failure("invalid_request")); void close(); return; }
      line(Buffer.concat([buffer, data.subarray(offset, end)])); buffer = Buffer.alloc(0); offset = end + 1;
    }
    if (buffer.length + data.length - offset > MAX_REQUEST_BYTES) { reject(null, failure("invalid_request")); void close(); return; }
    buffer = Buffer.concat([buffer, data.subarray(offset)]);
  });
  input.on("end", () => { if (buffer.length) reject(null, failure("invalid_request")); void close(); });
  input.on("error", () => { void close(); });
  return { close };
}

module.exports = { parseRequest, serveEmbeddedProtocol, MAX_REQUEST_BYTES };
