"use strict";
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { localEnvironment, expandHome } = require("./local-workspace");
const { commandShell } = require("./command-shell");
const { descendantGroups: collectDescendantGroups } = require("./embedded-children");
const MAX_COMMAND_BUFFER = 4 * 1024 * 1024;
const tail = (value) => value.length > 20000 ? value.slice(-20000) : value;

function runCommand({ cmd, cwd, timeout, shell, signal: abortSignal }, { signal = (pid, name) => process.kill(pid, name),
  descendantGroups = collectDescendantGroups, platform = process.platform } = {}) {
  const seconds = Math.max(1, Math.min(Number(timeout) || 60, 600));
  // Expand a leading ~ so home-relative working dirs work, and fail loudly with
  // a clear message when the dir is missing — otherwise a bad cwd makes exec
  // fail at spawn time and return a bare, confusing exit_code -1 with no output.
  const workdir = cwd ? expandHome(cwd) : undefined;
  if (workdir !== undefined) {
    let ok = false;
    try {
      ok = fs.statSync(workdir).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) {
      return { result: Promise.resolve({
        exit_code: -1,
        stdout: "",
        stderr: `cwd does not exist or is not a directory: ${workdir}`,
        cleanup_confirmed: true,
      }), snapshot: () => ({ stdout: "", stderr: "" }), cancel: () => {} };
    }
  }
  let cancel = () => {}, snapshot = () => ({ stdout: "", stderr: "" });
  const result = new Promise((resolve) => {
    const buffers = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
    let child, timer, escalation, transport, stopped, finished = false, forceStopped = false, treeUnconfirmed = false;
    const groups = new Set();
    const kill = (name) => {
      if (!child?.pid) return;
      if (name === "SIGKILL") {
        if (forceStopped) return;
        forceStopped = true;
      }
      // A denied signal is not an exit, but it must never crash the daemon or
      // prevent escalation/the bounded exit check from running.
      if (platform === "win32") {
        // Preserve upstream Windows tree termination. A successful taskkill is
        // still not independent evidence that every descendant exited.
        try { spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { timeout: 3000, windowsHide: true }); }
        catch { /* Bounded receipt below retains uncertainty. */ }
      }
      else for (const group of [child.pid, ...groups]) {
        try { signal(-group, name); } catch { /* Exit check below. */ }
      }
    };
    const stop = (reason) => {
      if (stopped || finished) return;
      stopped = reason;
      // Prove descendants while the shell is alive, before it can exit and
      // orphan a detached child. Never scan or signal another command's tree.
      if (child?.pid && platform !== "win32") {
        try { for (const group of descendantGroups(child.pid)) groups.add(group); } catch { treeUnconfirmed = true; }
      }
      kill("SIGTERM");
      escalation = setTimeout(() => {
        kill("SIGKILL");
        // A detached descendant can inherit the pipes after leaving the group.
        // It must not keep an HTTP request open beyond the termination grace.
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        finish(null);
      }, 1000);
    };
    const finish = async (code, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      abortSignal?.removeEventListener("abort", abort);
      // Children may have redirected their pipes before the shell exited.
      if (stopped) kill("SIGKILL");
      const exited = () => {
        if (!child?.pid) return true;
        if (platform === "win32") return child.exitCode != null || child.signalCode != null;
        return [child.pid, ...groups].every((group) => {
          try { signal(-group, 0); return false; } catch (error) { return error.code === "ESRCH"; }
        });
      };
      // A sent signal is not an exit receipt. Bound cleanup confirmation while
      // the event loop reaps children, and expose uncertainty if any survive.
      const cleanupDeadline = Date.now() + (stopped ? 1000 : 0);
      while (!exited() && Date.now() < cleanupDeadline) await new Promise((done) => setTimeout(done, 20));
      const stdout = Buffer.concat(buffers.stdout).toString("utf8");
      let stderr = Buffer.concat(buffers.stderr).toString("utf8");
      const reason = stopped || error?.message;
      if (reason) stderr += (stderr ? "\n" : "") + reason;
      // Windows taskkill requests tree termination, but this primitive does not
      // independently verify descendant exits. Keep the receipt truthful.
      const confirmed = !child?.pid || platform !== "win32" && !treeUnconfirmed && exited();
      if (stopped && !confirmed) stderr += "\nCommand process exit could not be confirmed.";
      try { transport?.cleanup(); } catch { /* Windows can retain an open script handle briefly. */ }
      resolve({ exit_code: stopped || error || code === null ? -1 : code,
        stdout: tail(stdout), stderr: tail(stderr), stopped: stopped || null, cleanup_confirmed: confirmed,
        shell: transport?.shell || shell, output_truncated: stdout.length > 20000 || stderr.length > 20000,
        ...(stopped ? { termination_reason: stopped } : {}) });
    };
    const abort = () => stop("cancelled");
    cancel = abort;
    snapshot = () => ({ stdout: tail(Buffer.concat(buffers.stdout).toString("utf8")),
      stderr: tail(Buffer.concat(buffers.stderr).toString("utf8")) });
    const capture = (name, chunk) => {
      if (finished) return;
      const remaining = MAX_COMMAND_BUFFER - sizes[name];
      if (remaining > 0) buffers[name].push(chunk.subarray(0, remaining));
      sizes[name] += chunk.length;
      if (sizes[name] > MAX_COMMAND_BUFFER) stop(`${name} exceeded the command output limit`);
    };
    try {
      if (abortSignal?.aborted) { stopped = "cancelled"; finish(null); return; }
      transport = commandShell(cmd, shell);
      child = spawn(transport.executable, transport.args, { cwd: workdir, env: localEnvironment(), shell: transport.spawnShell || false,
        detached: platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => capture("stdout", chunk));
      child.stderr.on("data", (chunk) => capture("stderr", chunk));
      child.once("error", (error) => finish(null, error));
      child.once("close", (code) => finish(code));
      timer = setTimeout(() => stop(`timed out after ${seconds}s`), seconds * 1000);
      abortSignal?.addEventListener("abort", abort, { once: true });
    } catch (error) { finish(null, error); }
  });
  return { result, cancel: () => cancel(), snapshot: () => snapshot() };
}

module.exports = { runCommand };
