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
//   POST /computer      -> one observed desktop input or screenshot {scope, control}
//   GET  /agents        -> check local Codex and Claude Code readiness
//   POST /agents/start  -> delegate {agent?, prompt, cwd?, workspace_write?}
//   GET  /agents/status -> wait up to 20 seconds for a job {job_id in query}
//   POST /agents/cancel -> request cancellation {job_id}
//   GET  /agents/jobs   -> recent jobs {request_key?, limit? in query}
//   POST /codex/start   -> start a local Codex task {prompt, cwd?, workspace_write?}
//   GET  /codex/status  -> wait up to 20 seconds for a job {job_id in query}
//   POST /codex/cancel  -> request cancellation {job_id}
//   GET  /codex/jobs    -> recent Codex jobs {request_key?, limit? in query}

const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { elevationStatus } = require("./command-shell");
const commandJobs = require("./command-jobs");
const { URL } = require("node:url");
const { startJob, publicStatus, listJobs, cancelJob, respondJob } = require("./codex");
const { listAgents } = require("./agents");
const { expandHome } = require("./local-workspace");
const { bundledRuntime } = require("./bundled-runtime");
const { createComputerControl } = require("./computer");
const { createSession, startSessionTurn, readSession, sessionEvents } = require("./sessions");
const { supportsToolProxy } = require("./native-tool-proxy");
const { runCommand: startCommandProcess } = require("./command-process");
const { commandStatus, cancelCommand } = require("./commands");

const MAX_OUTPUT = 20000;
const MAX_FILE_READ = 100000;
const MAX_DIRECTORY_ENTRIES = 2000;

const CAPABILITIES = {
  computer: "observe the Mac screen or send one keyboard/mouse action (requires computer_control capability)",
  run: "run a shell command",
  write: "create or replace a file",
  read: "read a file",
  ls: "list a directory",
  open: "open a file, app, or url with the OS default",
  sysinfo: "harmless machine stats",
  codex_start: "start a local Codex task using this computer's sign-in",
  codex_status: "wait for a local Codex task and collect its result",
  codex_cancel: "stop a local Codex task",
  codex_jobs: "list recent local Codex tasks to find a job_id again",
  agents: "discover installed and signed-in local Codex and Claude Code agents",
  agent_start: "delegate a task to a ready local agent",
  agent_status: "wait for a local agent task and collect its result",
  agent_cancel: "stop a local agent task",
  agent_jobs: "list recent local agent tasks to find a job_id again",
};

const CODEX_TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);

function codexReceipt(id, expectedAgent) {
  return publicStatus(id, expectedAgent);
}

async function waitForCodex(id, req, res, expectedAgent, immediate = false) {
  const deadline = Date.now() + (immediate ? 0 : 20000);
  let status = codexReceipt(id, expectedAgent);
  while (!CODEX_TERMINAL.has(status.state) && status.state !== "waiting_on_user" && Date.now() < deadline && !req.aborted && !res.destroyed) {
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

function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      // Guard against a runaway body (50 MB is plenty for file writes).
      if (size > limit) {
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

// Keep the public Promise contract used by independent command supervisors.
// The reusable process primitive also exposes cancellation and live output.
function runCommand(body) { return startCommandProcess(body).result; }


function openTarget(target) {
  const t = expandHome(target);
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

async function sysinfo(readElevation = elevationStatus) {
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
    bridge_version: require("../package.json").version,
    command_protocol: 1,
    default_shell: process.platform === "win32" ? "powershell" : "sh",
    ...await readElevation(),
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
function startServer({ port, token, computerControl = createComputerControl(), platform = process.platform, readElevation = elevationStatus }) {
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
      return sendJson(res, 200, { bridge: "shapes-bridge", actions: CAPABILITIES, features: {
        command_jobs: true, interactive_codex: true, idempotent_start: true, job_list: true, bundled_sessions: bundledRuntime().available,
        session_input: bundledRuntime().available,
        native_tool_proxy: supportsToolProxy() && bundledRuntime().available, computer_control: computerControl.available() } });
    }

    // Everything below requires the token.
    if (!authed(req)) {
      return sendJson(res, 401, { error: "bad or missing token" });
    }

    try {
      if (route === "/commands/start" && method === "POST") {
        try {
          const body = await readBody(req, 500000);
          if (body?.scope_id !== undefined) return sendJson(res, 409, {
            error: "Discover /sysinfo command_protocol before starting a new command.", error_type: "command_protocol_mismatch" });
          return sendJson(res, 202, await commandJobs.start(body));
        }
        catch (error) { return sendJson(res, error.statusCode || 500, { error: error.message, error_type: error.errorType || "command_start_failed", ...(error.jobId ? { job_id: error.jobId } : {}) }); }
      }
      if (route === "/commands/status" && method === "GET") {
        try {
          // Existing v0 receipts remain readable after a normal helper upgrade.
          if (url.searchParams.has("scope_id")) {
            if ([...url.searchParams.keys()].some((key) => !["command_id", "scope_id"].includes(key))) throw new Error("Unexpected legacy command argument.");
            return sendJson(res, 200, commandStatus(Object.fromEntries(url.searchParams)));
          }
          if ([...url.searchParams.keys()].some((key) => !["job_id", "scope", "wait"].includes(key))) throw new Error("Unexpected command status argument.");
          const id = url.searchParams.get("job_id"), scope = url.searchParams.get("scope");
          const deadline = Date.now() + (url.searchParams.get("wait") === "0" ? 0 : 15000);
          let result = commandJobs.status(id, scope);
          while (!commandJobs.TERMINAL.has(result.state) && Date.now() < deadline && !req.aborted && !res.destroyed) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            result = commandJobs.status(id, scope);
          }
          if (!res.destroyed) return sendJson(res, 200, result);
          return;
        } catch (error) { return sendJson(res, error.statusCode || 400, { error: error.message, error_type: error.errorType }); }
      }
      if (route === "/commands/cancel" && method === "POST") {
        try {
          const body = await readBody(req, 4096);
          if (body?.scope_id !== undefined) return sendJson(res, 200, cancelCommand(body));
          if (!body || Object.keys(body).some((key) => !["job_id", "scope"].includes(key))) throw new Error("Supply only job_id and scope.");
          return sendJson(res, 200, commandJobs.cancel(body.job_id, body.scope));
        } catch (error) { return sendJson(res, error.statusCode || 400, { error: error.message, error_type: error.errorType }); }
      }
      if (route === "/computer" && method === "POST") {
        const result = await computerControl.execute(await readBody(req, 32768));
        return sendJson(res, result.success ? 200 : 409, result);
      }
      if (route === "/sessions/create" && method === "POST") {
        try { return sendJson(res, 200, await createSession(await readBody(req))); }
        catch (error) { return sendJson(res, error.statusCode || 400, { error: error.message }); }
      }
      if (["/sessions/read", "/sessions/events"].includes(route) && method === "GET") {
        try {
          const id = url.searchParams.get("session_id"), scope = url.searchParams.get("scope_id");
          return sendJson(res, 200, route === "/sessions/read" ? readSession(id, scope)
            : sessionEvents(id, scope, url.searchParams.get("cursor") || "0:0"));
        } catch (error) { return sendJson(res, error.statusCode || 400, { error: error.message }); }
      }
      if (route === "/agents" && method === "GET") {
        log("AGENTS: checking local CLI readiness");
        return sendJson(res, 200, await listAgents());
      }

      if (["/codex/start", "/agents/start"].includes(route) && method === "POST") {
        try {
          const codexOnly = route === "/codex/start";
          const body = await readBody(req);
          if (!codexOnly && body?.session_id !== undefined) {
            const result = await startSessionTurn(body);
            return sendJson(res, result.deduplicated ? 200 : 202, result);
          }
          if (!body || typeof body !== "object" || Array.isArray(body)
              || Object.keys(body).some((key) => !["prompt", "cwd", "workspace_write", "interactive", "request_key", ...(codexOnly ? [] : ["agent"])].includes(key))
              || typeof body.prompt !== "string" || !body.prompt.trim()
              || (body.cwd !== undefined && typeof body.cwd !== "string")
              || (!codexOnly && body.agent !== undefined && !["auto", "codex", "claude"].includes(body.agent))
              || (body.workspace_write !== undefined && typeof body.workspace_write !== "boolean")
              || (body.interactive !== undefined && typeof body.interactive !== "boolean")
              || (body.request_key !== undefined && typeof body.request_key !== "string")) {
            return sendJson(res, 400, { error: "Supply prompt text, optional absolute cwd, boolean workspace_write, and a supported agent on /agents/start." });
          }
          const cwd = body.cwd ? expandHome(body.cwd) : process.cwd();
          const agent = codexOnly ? "codex" : body.agent || "auto";
          log(`AGENT START (${agent}, cwd=${cwd}, scope=${body.workspace_write ? "workspace-write" : "read-only"})`);
          const result = await startJob({
            prompt: body.prompt, cwd, agent,
            interactive: body.interactive === true, requestKey: body.request_key,
            sandbox: body.workspace_write ? "workspace-write" : "read-only",
          });
          if (result.deduplicated) log(`AGENT START deduplicated: ${result.job_id}`);
          return sendJson(res, result.deduplicated ? 200 : 202, result);
        } catch (err) {
          const job = err.jobId ? { job_id: err.jobId } : {};
          if (err.errorType === "agent_unavailable") return sendJson(res, 409,
            { error: err.message, error_type: err.errorType, started: false, agents: err.agents, ...job });
          return sendJson(res, err.statusCode || 400, { error: err.message, ...(err.jobId ? { started: false, ...job } : {}) });
        }
      }

      if (["/codex/jobs", "/agents/jobs"].includes(route) && method === "GET") {
        try {
          const unknown = [...url.searchParams.keys()].some((key) => !["request_key", "limit"].includes(key));
          if (unknown) return sendJson(res, 400, { error: "Supply optional request_key and limit." });
          log("AGENT JOBS: listing recent jobs");
          return sendJson(res, 200, listJobs({
            requestKey: url.searchParams.get("request_key") ?? undefined,
            limit: url.searchParams.get("limit") ?? 10,
            agent: route === "/codex/jobs" ? "codex" : undefined,
          }));
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (["/codex/status", "/agents/status"].includes(route) && method === "GET") {
        try {
          const id = url.searchParams.get("job_id");
          log(`AGENT STATUS: ${id}`);
          const result = await waitForCodex(id, req, res, route === "/codex/status" ? "codex" : undefined, url.searchParams.get("wait") === "0");
          if (!res.destroyed) return sendJson(res, 200, result);
          return;
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      // Human UI service only. Deliberately absent from the model's capabilities
      // actions: a task may request consent, but cannot answer its own prompt.
      if (route === "/agents/respond" && method === "POST") {
        try {
          const body = await readBody(req);
          if (!body || typeof body !== "object" || Array.isArray(body)
              || Object.keys(body).some((key) => !["job_id", "request_id", "response"].includes(key))
              || typeof body.job_id !== "string" || typeof body.request_id !== "string") {
            return sendJson(res, 400, { error: "Supply job_id, request_id, and a response." });
          }
          return sendJson(res, 200, respondJob(body.job_id, body.request_id, body.response));
        } catch (error) {
          return sendJson(res, error.statusCode || 400, { error: error.message });
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
        return sendJson(res, 200, await sysinfo(readElevation));
      }

      if (route === "/run" && method === "POST") {
        const body = await readBody(req);
        if (!body || typeof body.cmd !== "string" || !body.cmd.trim()
            || (body.cwd !== undefined && typeof body.cwd !== "string")) {
          return sendJson(res, 400, { error: "Supply cmd text and optional cwd text." });
        }
        log(`RUN: ${body.cmd}   (cwd=${body.cwd || process.cwd()})`);
        const { stopped, cleanup_confirmed, ...result } = await commandJobs.mutation(() => runCommand(body));
        return sendJson(res, 200, result);
      }

      if (route === "/write" && method === "POST") {
        const body = await readBody(req);
        if (!body.path || body.content === undefined) {
          return sendJson(res, 400, { error: "'path' and 'content' are required" });
        }
        const p = expandHome(body.path);
        log(`WRITE: ${p} (${Buffer.byteLength(body.content)} bytes)`);
        const result = await commandJobs.mutation(() => {
          fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
          fs.writeFileSync(p, body.content, "utf8");
          return { wrote: p, bytes: Buffer.byteLength(body.content), finished_at: Date.now() };
        });
        return sendJson(res, 200, result);
      }

      if (route === "/read" && method === "GET") {
        const p = expandHome(url.searchParams.get("path"));
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
          modified_at: stat.mtimeMs,
          observed_at: Date.now(),
        });
      }

      if (route === "/ls" && method === "GET") {
        const p = expandHome(url.searchParams.get("path") || ".");
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
        return sendJson(res, 200, await commandJobs.mutation(() => openTarget(body.target)));
      }

      return sendJson(res, 404, { error: `no route ${method} ${route}` });
    } catch (err) {
      return sendJson(res, err.statusCode || 500, { error: String(err && err.message ? err.message : err), ...(err.errorType ? { error_type: err.errorType } : {}) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

module.exports = { startServer, runCommand };
