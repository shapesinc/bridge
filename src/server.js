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
//   GET  /agents        -> check local Codex and Claude Code readiness
//   POST /agents/start  -> delegate {agent?, prompt, cwd?, workspace_write?}
//   GET  /agents/status -> wait up to 20 seconds for a job {job_id in query}
//   POST /agents/cancel -> request cancellation {job_id}
//   POST /codex/start   -> start a local Codex task {prompt, cwd?, workspace_write?}
//   GET  /codex/status  -> wait up to 20 seconds for a job {job_id in query}
//   POST /codex/cancel  -> request cancellation {job_id}

const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { exec, spawn } = require("node:child_process");
const { URL } = require("node:url");
const { startJob, getStatus, cancelJob } = require("./codex");
const { listAgents } = require("./agents");

const MAX_OUTPUT = 20000;
const MAX_FILE_READ = 100000;
const MAX_COMMAND_BUFFER = 4 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 2000;

const CAPABILITIES = {
  run: "run a shell command",
  write: "create or replace a file",
  read: "read a file",
  ls: "list a directory",
  open: "open a file, app, or url with the OS default",
  sysinfo: "harmless machine stats",
  codex_start: "start a local Codex task using this computer's sign-in",
  codex_status: "wait for a local Codex task and collect its result",
  codex_cancel: "stop a local Codex task",
  agents: "discover installed and signed-in local Codex and Claude Code agents",
  agent_start: "delegate a task to a ready local agent",
  agent_status: "wait for a local agent task and collect its result",
  agent_cancel: "stop a local agent task",
};

const CODEX_TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);

function codexReceipt(id, expectedAgent) {
  const { diagnostics_directory, diagnostics_available, ...receipt } = getStatus(id, expectedAgent);
  return receipt;
}

async function waitForCodex(id, req, res, expectedAgent) {
  const deadline = Date.now() + 20000;
  let status = codexReceipt(id, expectedAgent);
  while (!CODEX_TERMINAL.has(status.state) && Date.now() < deadline && !req.aborted && !res.destroyed) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = codexReceipt(id, expectedAgent);
  }
  return status;
}

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
  // Expand a leading ~ so home-relative working dirs work, and fail loudly with
  // a clear message when the dir is missing — otherwise a bad cwd makes exec
  // fail at spawn time and return a bare, confusing exit_code -1 with no output.
  const workdir = cwd ? expand(cwd) : undefined;
  if (workdir !== undefined) {
    let ok = false;
    try {
      ok = fs.statSync(workdir).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) {
      return Promise.resolve({
        exit_code: -1,
        stdout: "",
        stderr: `cwd does not exist or is not a directory: ${workdir}`,
      });
    }
  }
  return new Promise((resolve) => {
    exec(
      cmd,
      {
        cwd: workdir,
        timeout: seconds * 1000,
        maxBuffer: MAX_COMMAND_BUFFER,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        let exitCode = 0;
        let errText = stderr || "";
        if (err) {
          if (err.killed) {
            errText += `\ntimed out after ${seconds}s`;
          } else if (typeof err.code !== "number") {
            // Spawn-level failure (bad cwd, shell missing, etc.) — surface the
            // reason instead of an empty -1.
            errText += (errText ? "\n" : "") + (err.message || String(err));
          }
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
    if (!token || typeof provided !== "string") return false;
    const expected = Buffer.from(token);
    const actual = Buffer.from(provided);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
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
      if (route === "/agents" && method === "GET") {
        log("AGENTS: checking local CLI readiness");
        return sendJson(res, 200, await listAgents());
      }

      if (["/codex/start", "/agents/start"].includes(route) && method === "POST") {
        try {
          const codexOnly = route === "/codex/start";
          const body = await readBody(req);
          if (!body || typeof body !== "object" || Array.isArray(body)
              || Object.keys(body).some((key) => !["prompt", "cwd", "workspace_write", ...(codexOnly ? [] : ["agent"])].includes(key))
              || typeof body.prompt !== "string" || !body.prompt.trim()
              || (body.cwd !== undefined && typeof body.cwd !== "string")
              || (!codexOnly && body.agent !== undefined && !["auto", "codex", "claude"].includes(body.agent))
              || (body.workspace_write !== undefined && typeof body.workspace_write !== "boolean")) {
            return sendJson(res, 400, { error: "Supply prompt text, optional absolute cwd, boolean workspace_write, and a supported agent on /agents/start." });
          }
          const cwd = body.cwd ? expand(body.cwd) : process.cwd();
          const agent = codexOnly ? "codex" : body.agent || "auto";
          log(`AGENT START (${agent}, cwd=${cwd}, scope=${body.workspace_write ? "workspace-write" : "read-only"})`);
          const result = await startJob({
            prompt: body.prompt, cwd, agent,
            sandbox: body.workspace_write ? "workspace-write" : "read-only",
          });
          return sendJson(res, 202, result);
        } catch (err) {
          if (err.errorType === "agent_unavailable") return sendJson(res, 409,
            { error: err.message, error_type: err.errorType, started: false, agents: err.agents });
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (["/codex/status", "/agents/status"].includes(route) && method === "GET") {
        try {
          const id = url.searchParams.get("job_id");
          log(`AGENT STATUS: ${id}`);
          const result = await waitForCodex(id, req, res, route === "/codex/status" ? "codex" : undefined);
          if (!res.destroyed) return sendJson(res, 200, result);
          return;
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (["/codex/cancel", "/agents/cancel"].includes(route) && method === "POST") {
        try {
          const body = await readBody(req);
          if (!body || typeof body !== "object" || Array.isArray(body)
              || Object.keys(body).some((key) => key !== "job_id") || typeof body.job_id !== "string") {
            return sendJson(res, 400, { error: "Supply job_id." });
          }
          log(`AGENT CANCEL: ${body.job_id}`);
          return sendJson(res, 200, cancelJob(body.job_id, route === "/codex/cancel" ? "codex" : undefined));
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

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
        const stat = fs.statSync(p);
        if (!stat.isFile()) return sendJson(res, 400, { error: "path is not a file" });
        const size = Math.min(stat.size, MAX_FILE_READ);
        const buffer = Buffer.alloc(size);
        const fd = fs.openSync(p, "r");
        try {
          fs.readSync(fd, buffer, 0, size, 0);
        } finally {
          fs.closeSync(fd);
        }
        return sendJson(res, 200, {
          path: p,
          content: buffer.toString("utf8"),
          truncated: stat.size > MAX_FILE_READ,
        });
      }

      if (route === "/ls" && method === "GET") {
        const p = expand(url.searchParams.get("path") || ".");
        log(`LS: ${p}`);
        const allNames = fs.readdirSync(p).sort();
        const entries = allNames.slice(0, MAX_DIRECTORY_ENTRIES).map((name) => {
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
        return sendJson(res, 200, {
          path: p,
          entries,
          truncated: allNames.length > MAX_DIRECTORY_ENTRIES,
        });
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
