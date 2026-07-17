"use strict";

// The bridge server — a token-locked local door your Shape reaches through the
// tunnel. Every endpoint except /health and /capabilities requires the secret
// token, and every action prints live in the terminal so you SEE what runs.
//
// Endpoints map 1:1 to the SHAPES_BRIDGE tool actions in the Shapes app:
//   GET  /health        -> is it alive? (no secret)
//   GET  /capabilities  -> what this bridge can do (no secret)
//   GET  /sysinfo       -> harmless machine stats
//   POST /run           -> run a shell command  {cmd, cwd?, timeout?}
//   POST /write         -> create/replace a file {path, content}
//   GET  /read?path=    -> read a file back
//   GET  /ls?path=      -> list a directory
//   POST /open          -> open a file/app/url with the OS default {target}

const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { exec, spawn } = require("node:child_process");
const { URL } = require("node:url");

const MAX_OUTPUT = 20000;
const MAX_FILE_READ = 100000;

const CAPABILITIES = {
  run: "run a shell command",
  write: "create or replace a file",
  read: "read a file",
  ls: "list a directory",
  open: "open a file, app, or url with the OS default",
  sysinfo: "harmless machine stats",
};

function log(msg) {
  process.stdout.write(`[bridge] ${msg}\n`);
}

function tail(value, max = MAX_OUTPUT) {
  if (typeof value !== "string") return value;
  return value.length > max ? value.slice(-max) : value;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      // Guard against a runaway body (50 MB is plenty for file writes).
      if (size > 50 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function runCommand({ cmd, cwd, timeout }) {
  const seconds = Math.max(1, Math.min(Number(timeout) || 60, 600));
  return new Promise((resolve) => {
    exec(
      cmd,
      {
        cwd: cwd || undefined,
        timeout: seconds * 1000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        let exitCode = 0;
        let errText = stderr || "";
        if (err) {
          if (err.killed) errText += `\ntimed out after ${seconds}s`;
          exitCode = typeof err.code === "number" ? err.code : -1;
        }
        resolve({
          exit_code: exitCode,
          stdout: tail(stdout || ""),
          stderr: tail(errText),
        });
      }
    );
  });
}

function openTarget(target) {
  const t = target.startsWith("~") ? path.join(os.homedir(), target.slice(1)) : target;
  const platform = process.platform;
  if (platform === "darwin") {
    spawn("open", [t], { detached: true, stdio: "ignore" }).unref();
  } else if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", t], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } else {
    spawn("xdg-open", [t], { detached: true, stdio: "ignore" }).unref();
  }
  return { opened: t };
}

function expand(p) {
  if (!p) return p;
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function sysinfo() {
  const home = os.homedir();
  let disk = null;
  try {
    const stat = fs.statfsSync ? fs.statfsSync(home) : null;
    if (stat) {
      disk = {
        total: Math.round((stat.blocks * stat.bsize) / 1e9 * 10) / 10,
        free: Math.round((stat.bfree * stat.bsize) / 1e9 * 10) / 10,
      };
    }
  } catch {
    disk = null;
  }
  return {
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu_count: os.cpus().length,
    mem_gb: Math.round((os.totalmem() / 1e9) * 10) / 10,
    home,
    cwd: process.cwd(),
    disk_gb: disk,
  };
}

/**
 * Start the bridge HTTP server.
 * @param {{port:number, token:string}} opts
 * @returns {Promise<import('node:http').Server>}
 */
function startServer({ port, token }) {
  const authed = (req) => {
    const provided = req.headers["x-token"];
    return Boolean(token) && provided === token;
  };

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      return sendJson(res, 400, { error: "bad url" });
    }
    const route = url.pathname;
    const method = req.method || "GET";

    // Public endpoints (no token).
    if (route === "/health" && method === "GET") {
      return sendJson(res, 200, { ok: true });
    }
    if (route === "/capabilities" && method === "GET") {
      return sendJson(res, 200, { bridge: "shapes-bridge", actions: CAPABILITIES });
    }

    // Everything below requires the token.
    if (!authed(req)) {
      return sendJson(res, 401, { error: "bad or missing token" });
    }

    try {
      if (route === "/sysinfo" && method === "GET") {
        log("sysinfo requested");
        return sendJson(res, 200, sysinfo());
      }

      if (route === "/run" && method === "POST") {
        const body = await readBody(req);
        if (!body.cmd) return sendJson(res, 400, { error: "'cmd' is required" });
        log(`RUN: ${body.cmd}   (cwd=${body.cwd || process.cwd()})`);
        const result = await runCommand(body);
        return sendJson(res, 200, result);
      }

      if (route === "/write" && method === "POST") {
        const body = await readBody(req);
        if (!body.path || body.content === undefined) {
          return sendJson(res, 400, { error: "'path' and 'content' are required" });
        }
        const p = expand(body.path);
        log(`WRITE: ${p} (${Buffer.byteLength(body.content)} bytes)`);
        fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
        fs.writeFileSync(p, body.content, "utf8");
        return sendJson(res, 200, { wrote: p, bytes: Buffer.byteLength(body.content) });
      }

      if (route === "/read" && method === "GET") {
        const p = expand(url.searchParams.get("path"));
        if (!p) return sendJson(res, 400, { error: "'path' is required" });
        log(`READ: ${p}`);
        const content = fs.readFileSync(p, "utf8").slice(0, MAX_FILE_READ);
        return sendJson(res, 200, { path: p, content });
      }

      if (route === "/ls" && method === "GET") {
        const p = expand(url.searchParams.get("path") || ".");
        log(`LS: ${p}`);
        const entries = fs.readdirSync(p).sort().map((name) => {
          const full = path.join(p, name);
          let isDir = false;
          let size = null;
          try {
            const st = fs.statSync(full);
            isDir = st.isDirectory();
            size = st.isFile() ? st.size : null;
          } catch {
            // Unreadable entry (permissions / broken symlink) — list name only.
          }
          return { name, dir: isDir, size };
        });
        return sendJson(res, 200, { path: p, entries });
      }

      if (route === "/open" && method === "POST") {
        const body = await readBody(req);
        if (!body.target) return sendJson(res, 400, { error: "'target' is required" });
        log(`OPEN: ${body.target}`);
        return sendJson(res, 200, openTarget(body.target));
      }

      return sendJson(res, 404, { error: `no route ${method} ${route}` });
    } catch (err) {
      return sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

module.exports = { startServer };
