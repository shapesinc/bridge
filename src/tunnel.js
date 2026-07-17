"use strict";

// Open a Cloudflare quick-tunnel (no account, temporary) in front of the local
// bridge, and pull the public https://<random>.trycloudflare.com URL out of
// cloudflared's own output.

const { spawn } = require("node:child_process");
const { ensureCloudflared } = require("./cloudflared");

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * @param {{port:number, log?:(msg:string)=>void}} opts
 * @returns {Promise<{url:string, child:import('node:child_process').ChildProcess}>}
 */
async function startTunnel({ port, log = () => {} }) {
  const bin = await ensureCloudflared(log);
  log("opening secure public tunnel…");

  const child = spawn(
    bin,
    ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("timed out waiting for tunnel URL"));
    }, 30000);

    const scan = (buf) => {
      const m = String(buf).match(URL_RE);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: m[0], child });
      }
    };

    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`tunnel exited early (code ${code})`));
      }
    });
  });
}

module.exports = { startTunnel };
