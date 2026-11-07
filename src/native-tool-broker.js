"use strict";

const path = require("node:path");
const { listenPrivateChannel } = require("./private-channel");
const { randomUUID } = require("node:crypto");
const { DEFINITIONS, supportsToolProxy } = require("./native-tool-proxy");

async function createToolBroker(proxy) {
  if (!supportsToolProxy()) throw new Error("The native capability broker is unavailable on this platform.");
  const sockets = new Set();
  const channel = await listenPrivateChannel({ scope: proxy.runId, onConnection(socket) {
    sockets.add(socket);
    const connectionId = randomUUID(), pending = new Set();
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { sockets.delete(socket); for (const id of pending) void proxy.resolved(id, "transport_closed"); });
    socket.on("data", chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line) > 64 * 1024) { socket.destroy(); return; }
        try {
          const message = JSON.parse(line), id = `${connectionId}:${message.id}`;
          if (message.method === "cancel") { void proxy.resolved(id, "cancelled"); continue; }
          if (message.method !== "call" || pending.has(id)) { socket.destroy(); return; }
          pending.add(id);
          void proxy.handle({ id, method: "item/tool/call", params: message.params }).then(result => {
            if (!socket.destroyed) socket.write(JSON.stringify({ id: message.id, result }) + "\n");
          }).catch(() => socket.destroy()).finally(() => pending.delete(id));
        } catch { socket.destroy(); return; }
      }
      if (Buffer.byteLength(buffer) > 64 * 1024) socket.destroy();
    });
  } });
  let closing;
  return {
    directory: channel.directory,
    launchArgs: ["-c", `mcp_servers.shapes.command=${JSON.stringify(process.execPath)}`,
      "-c", `mcp_servers.shapes.args=${JSON.stringify([path.join(__dirname, "native-tool-mcp.js"), channel.endpoint, proxy.runId, channel.credentialFile])}`,
      // Only this grant-backed proxy owns these tools. The backend performs
      // current authorization; no other MCP server or native approval changes.
      "-c", `mcp_servers.shapes.enabled_tools=${JSON.stringify(DEFINITIONS.map(tool => tool.name))}`,
      ...DEFINITIONS.flatMap(tool => ["-c", `mcp_servers.shapes.tools.${tool.name}.approval_mode="approve"`]),
      "-c", "mcp_servers.shapes.required=true",
      "-c", "mcp_servers.shapes.startup_timeout_sec=5", "-c", "mcp_servers.shapes.tool_timeout_sec=20"],
    close() {
      if (!closing) closing = (async () => {
        try { await proxy.close(); }
        finally { for (const socket of sockets) socket.destroy(); await channel.close(); }
      })();
      return closing;
    },
  };
}

module.exports = { createToolBroker };
