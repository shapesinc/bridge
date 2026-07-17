#!/usr/bin/env node
"use strict";

// shapes-bridge — give your Shape hands on your own computer, with your consent.
//
//   npx github:shapesinc/bridge
//
// Starts a token-locked local server, opens a temporary public tunnel, and
// prints ONE line to paste into your chat. Every action your Shape runs prints
// live in this terminal. Ctrl+C shuts the door instantly.

const crypto = require("node:crypto");
const net = require("node:net");
const { startServer } = require("../src/server");
const { startTunnel } = require("../src/tunnel");

const MARKER = "BRIDGE";

function log(msg) {
  process.stdout.write(`==> ${msg}\n`);
}

function findOpenPort(preferred) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(0)); // 0 => let the OS pick
    srv.listen(preferred, "127.0.0.1", () => {
      srv.close(() => resolve(preferred));
    });
  });
}

function banner(url, token) {
  const line = `${MARKER} ${url} ${token}`;
  const bar = "=".repeat(67);
  process.stdout.write(
    [
      "",
      bar,
      "  Computer bridge LIVE. Paste this ONE line into your chat:",
      "",
      `   ${line}`,
      "",
      "  Treat it like a password — it lets that chat act on this computer",
      "  until you close this terminal. Every action prints below, live.",
      "  Ctrl+C = shut the door (URL + token die instantly).",
      bar,
      "",
    ].join("\n")
  );
}

async function main() {
  log("Shapes computer bridge");
  const token = crypto.randomBytes(18).toString("base64url");
  const port = (await findOpenPort(8078)) || (await findOpenPort(0));

  const server = await startServer({ port, token });
  const actualPort = server.address().port;
  log(`bridge listening on 127.0.0.1:${actualPort}`);

  let tunnel;
  try {
    tunnel = await startTunnel({ port: actualPort, log });
  } catch (err) {
    process.stderr.write(`\n✗ could not open tunnel: ${err.message}\n`);
    server.close();
    process.exit(1);
  }

  banner(tunnel.url, token);

  const shutdown = () => {
    process.stdout.write("\n==> closing the door…\n");
    try {
      tunnel.child.kill();
    } catch {}
    server.close(() => process.exit(0));
    // Hard-exit fallback if close hangs.
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  tunnel.child.on("exit", () => {
    process.stderr.write("\n✗ tunnel closed unexpectedly. Run the bridge again.\n");
    server.close(() => process.exit(1));
  });
}

main().catch((err) => {
  process.stderr.write(`\n✗ ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
