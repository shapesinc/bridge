"use strict";

const fs = require("node:fs");
const terminal = new Set(["completed", "failed", "cancelled", "timed_out"]);
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

// Only opt-in disposable replays call this with their own recorded job IDs.
// Emergency cleanup remains a test failure, never successful native cleanup.
async function stopReplayJobs({ jobs, cancelJob, getState, timeoutMs = 10000 }) {
  const states = new Map();
  const cancellation = await Promise.allSettled(jobs.map(id => Promise.resolve().then(() => cancelJob(id))));
  async function settled(duration) {
    const deadline = Date.now() + duration;
    do {
      let complete = true;
      for (const id of jobs) {
        try {
          const state = getState(id); states.set(id, state);
          if (!terminal.has(state.status) || alive(state.supervisorPid) || alive(state.agentPid)) complete = false;
        } catch { complete = false; }
      }
      if (complete) return true;
      await new Promise(resolve => setTimeout(resolve, 40));
    } while (Date.now() < deadline);
    return false;
  }
  if (await settled(timeoutMs)) {
    if (cancellation.some(result => result.status === "rejected")) throw new Error("Replay cancellation failed despite observed process exit.");
    return;
  }
  for (const state of states.values()) {
    for (const [pid, group] of [[state.agentPid, true], [state.supervisorPid, false]]) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try { process.kill(process.platform !== "win32" && group ? -pid : pid, "SIGKILL"); }
      catch { /* Continue every owned cleanup; absence is checked below. */ }
    }
  }
  const cleaned = await settled(3000);
  throw new Error(cleaned ? "Replay required emergency owned-process cleanup." : "Replay owned-process cleanup remains unconfirmed.");
}

async function cleanupReplay({ servers, root, ...jobs }) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => stopReplayJobs(jobs)),
    ...servers.filter(Boolean).map(server => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
    })),
  ]);
  if (results.some(result => result.status === "rejected")) {
    // Retain only this fixture's state for diagnosis if cleanup is uncertain.
    throw new AggregateError(results.filter(result => result.status === "rejected").map(result => result.reason), "Replay cleanup failed; fixture state retained.");
  }
  fs.rmSync(root, { recursive: true, force: true });
}
module.exports = { stopReplayJobs, cleanupReplay };
