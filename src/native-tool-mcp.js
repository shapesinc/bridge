"use strict";

const { connectPrivateChannel } = require("./private-channel");
const { DEFINITIONS, operationId } = require("./native-tool-proxy");

// A stdio MCP frontend has no provider or capability credentials. The private
// supervisor broker owns authorization, the active native turn and HTTP IO.
async function serveMcp({ socketPath, runId, credentialFile, input = process.stdin, output = process.stdout } = {}) {
  // Required MCP startup cannot succeed before the private broker authenticates.
  input.pause();
  const socket = await connectPrivateChannel({ endpoint: socketPath, credentialFile, scope: runId }), pending = new Map();
  let inputBuffer = "", brokerBuffer = "", closed = false;
  const send = value => { if (!closed) output.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n"); };
  const respondError = (id, message) => send({ id, error: { code: -32602, message } });
  function close() { closed = true; socket.destroy(); input.pause(); }
  function transportFailure() {
    for (const [id, operation_id] of pending) send({ id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ success: false,
      error_type: "tool_outcome_unknown", error: "The local capability transport stopped. Read the operation receipt before repeating an action.", retryable: false,
      ...(operation_id ? { result: { operation_id, status: "outcome_unknown" } } : {}) }) }] } });
    pending.clear();
    close();
  }
  socket.on("error", transportFailure);
  socket.on("close", transportFailure);
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    brokerBuffer += chunk;
    if (Buffer.byteLength(brokerBuffer) > 128 * 1024) { close(); return; }
    let index;
    while ((index = brokerBuffer.indexOf("\n")) >= 0) {
      const line = brokerBuffer.slice(0, index); brokerBuffer = brokerBuffer.slice(index + 1);
      try {
        const message = JSON.parse(line);
        if (!pending.delete(message.id)) continue;
        send({ id: message.id, result: { isError: message.result.success !== true,
          content: message.result.contentItems.map(item => ({ type: "text", text: item.text })) } });
      } catch { close(); return; }
    }
  });
  input.setEncoding("utf8");
  input.on("data", chunk => {
    inputBuffer += chunk;
    let index;
    while ((index = inputBuffer.indexOf("\n")) >= 0) {
      const line = inputBuffer.slice(0, index); inputBuffer = inputBuffer.slice(index + 1);
      if (Buffer.byteLength(line) > 64 * 1024) { close(); return; }
      try {
        const message = JSON.parse(line), id = message.id;
        if (message.method === "notifications/cancelled") {
          if (pending.delete(message.params?.requestId)) socket.write(JSON.stringify({ method: "cancel", id: message.params.requestId }) + "\n");
          continue;
        }
        if (!Object.hasOwn(message, "id")) continue;
        if (typeof id !== "string" && !(typeof id === "number" && Number.isSafeInteger(id))) { close(); return; }
        if (message.method === "initialize") {
          send({ id, result: { protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} },
            serverInfo: { name: "shapes.inc", version: "1" },
            instructions: "Discover shapes.inc connected capabilities with shapes_discover, then describe the chosen capability before calling it. Read operation receipts after unknown outcomes; never repeat an unconfirmed action." } });
        } else if (message.method === "ping") send({ id, result: {} });
        else if (message.method === "tools/list") send({ id, result: { tools: DEFINITIONS.map(({ inputSchema, ...tool }) => ({ ...tool, inputSchema })) } });
        else if (message.method === "tools/call") {
          const params = message.params || {}, meta = params._meta || {}, turn = meta["x-codex-turn-metadata"] || {};
          if (pending.has(id)) { respondError(id, "Duplicate pending tool request."); continue; }
          const native = { threadId: meta.threadId, turnId: turn.turn_id, callId: meta.callId, namespace: null, tool: params.name, arguments: params.arguments };
          pending.set(id, params.name === "shapes_call" ? operationId({ run_id: runId }, native) : params.arguments?.operation_id);
          socket.write(JSON.stringify({ method: "call", id, params: native }) + "\n");
        } else send({ id, error: { code: -32601, message: "Unsupported capability transport method." } });
      } catch { close(); return; }
    }
    if (Buffer.byteLength(inputBuffer) > 64 * 1024) close();
  });
  input.on("end", close);
  socket.resume(); input.resume();
  return { close };
}

if (require.main === module) void serveMcp({ socketPath: process.argv[2], runId: process.argv[3], credentialFile: process.argv[4] })
  .catch(() => { process.stderr.write("The private capability transport could not start.\n"); process.exitCode = 1; });
module.exports = { serveMcp };
