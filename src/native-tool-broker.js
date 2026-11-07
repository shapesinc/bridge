"use strict";

const fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const { randomUUID } = require("node:crypto");
const { DEFINITIONS, supportsToolProxy } = require("./native-tool-proxy");

async function createToolBroker(proxy) {
  if (!supportsToolProxy()) throw new Error("The native capability broker requires macOS or Linux.");
  // Keep the Unix path below macOS's sockaddr limit. mkdtemp is atomic and the
  // account-only directory prevents another account from connecting.
  const directory = fs.mkdtempSync("/tmp/shapes-native-tools-"); fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, "broker.sock"), sockets = new Set();
  const server = net.createServer(socket => {
    if (sockets.size >= 4) { socket.destroy(); return; }
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
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    fs.chmodSync(socketPath, 0o600);
  } catch (error) { server.close(); fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  let closing;
  return {
    directory,
    launchArgs: ["-c", `mcp_servers.shapes.command=${JSON.stringify(process.execPath)}`,
      "-c", `mcp_servers.shapes.args=${JSON.stringify([path.join(__dirname, "native-tool-mcp.js"), socketPath, proxy.runId])}`,
      // Only this grant-backed proxy owns these tools. The backend performs
      // current authorization; no other MCP server or native approval changes.
      "-c", `mcp_servers.shapes.enabled_tools=${JSON.stringify(DEFINITIONS.map(tool => tool.name))}`,
      ...DEFINITIONS.flatMap(tool => ["-c", `mcp_servers.shapes.tools.${tool.name}.approval_mode="approve"`]),
      "-c", "mcp_servers.shapes.required=true",
      "-c", "mcp_servers.shapes.startup_timeout_sec=5", "-c", "mcp_servers.shapes.tool_timeout_sec=20"],
    close() {
      if (!closing) closing = (async () => {
        await proxy.close();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
      })();
      return closing;
    },
  };
}

module.exports = { createToolBroker };
