"use strict";
const fs = require("node:fs");
const { spawnOwned, signalOwned, ownedCleanup, disposeOwned } = require("./owned-process");
const { localEnvironment, expandHome } = require("./local-workspace");
const { commandShell } = require("./command-shell");
const { descendantGroups: collectDescendantGroups } = require("./embedded-children");
const MAX_COMMAND_BUFFER = 4 * 1024 * 1024;
const tail = (value) => value.length > 20000 ? value.slice(-20000) : value;

function runCommand({ cmd, cwd, timeout, shell, signal: abortSignal }, { signal = (pid, name) => process.kill(pid, name),
  descendantGroups = collectDescendantGroups, platform = process.platform, spawnProcess = spawnOwned,
  signalProcess = signalOwned } = {}) {
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
    let child, timer, escalation, settlement, transport, stopped, handoffError, finished = false, forceStopped = false, treeUnconfirmed = false, handoff = false;
    const outputEnded = { stdout: false, stderr: false };
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
        // The exact wrapper owns a non-breakaway Job; never enumerate or
        // taskkill an unrelated/reused PID. A signal still is not an exit receipt.
        try { signalProcess(child, name); } catch { /* Bounded uncertainty below. */ }
      }
      else for (const group of [child.pid, ...groups]) {
        try { signal(-group, name); } catch { /* Exit check below. */ }
      }
    };
    const stop = (reason) => {
      if (stopped || finished || handoff) return;
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
      clearTimeout(settlement);
      child?.stdin?.destroy();
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
      // A Windows Job kill request is stronger ownership than a PID tree scan,
      // but wrapper exit alone is not an independently observed empty Job.
      // Until its native receipt proves completion, retain uncertainty.
      const confirmed = !child?.pid || (platform === "win32" ? ownedCleanup(child) === true : !treeUnconfirmed && exited());
      // Success may intentionally release a live background Job after both
      // outputs settle. Every other started Windows observer exit requires
      // native proof; helper failure without it is an unknown outcome.
      const uncertain = platform === "win32" && !!child?.pid && !confirmed
        && !(code === 0 && handoff && !error && !stopped);
      if ((stopped && !confirmed) || uncertain) stderr += "\nCommand process exit could not be confirmed.";
      disposeOwned(child);
      if (platform === "win32" && child?.pid && !exited()) child.unref();
      try { transport?.cleanup(); } catch { /* Windows can retain an open script handle briefly. */ }
      resolve({ exit_code: uncertain || stopped || error || code === null ? -1 : code,
        stdout: tail(stdout), stderr: tail(stderr), stopped: stopped || null, cleanup_confirmed: confirmed,
        ...(uncertain ? { outcome_unknown: true, error_type: "command_exit_unconfirmed" } : {}),
        shell: transport?.shell || shell, output_truncated: stdout.length > 20000 || stderr.length > 20000,
        ...(stopped ? { termination_reason: stopped === "cancelled" ? "command cancelled" : stopped } : {}) });
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
    const releaseAfterOutput = (name) => {
      outputEnded[name] = true;
      if (!outputEnded.stdout || !outputEnded.stderr || stopped || finished || handoff || child.exitCode !== null || child.signalCode !== null) return;
      // Output EOF commits successful ownership handoff. A failed helper can
      // also close outputs before exit: preserve its eventual nonzero status
      // even if writing the control message encounters EPIPE.
      handoff = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", abort);
      settlement = setTimeout(() => { kill("SIGKILL"); finish(null, new Error("Windows process ownership handoff did not finish")); }, 5000);
      child.stdin.end("release\n");
    };
    try {
      if (abortSignal?.aborted) { stopped = "cancelled"; finish(null); return; }
      transport = commandShell(cmd, shell);
      child = spawnProcess(transport.executable, transport.args, { cwd: workdir, env: localEnvironment(),
        windowsCommand: transport.windowsCommand || false, releaseOnSuccess: true, cleanupReceipt: true,
        detached: platform !== "win32", windowsHide: true, stdio: [platform === "win32" ? "pipe" : "ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => capture("stdout", chunk));
      child.stderr.on("data", (chunk) => capture("stderr", chunk));
      if (platform === "win32") {
        child.stdout.once("end", () => releaseAfterOutput("stdout"));
        child.stderr.once("end", () => releaseAfterOutput("stderr"));
        child.stdin.on("error", () => { handoffError = new Error("Windows process ownership handoff failed"); });
      }
      child.once("error", (error) => finish(null, error));
      child.once("close", (code) => finish(code, code === 0 ? handoffError : undefined));
      timer = setTimeout(() => stop(`timed out after ${seconds}s`), seconds * 1000);
      abortSignal?.addEventListener("abort", abort, { once: true });
    } catch (error) { finish(null, error); }
  });
  return { result, cancel: () => cancel(), snapshot: () => snapshot() };
}

module.exports = { runCommand };
