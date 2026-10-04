"use strict";

const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A process can fail before start() reaches its final await.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function normalizedItem(item) {
  const types = { agentMessage: "agent_message", mcpToolCall: "mcp_tool_call", commandExecution: "command_execution", fileChange: "file_change" };
  return { ...item, type: types[item.type] || item.type,
    ...(item.status === "inProgress" ? { status: "in_progress" } : {}) };
}

// The caller owns user authentication, presentation and response validation.
// This transport never converts model text into approvals or answers a request.
function createCodexRpcSession({ executable, cwd, sandbox = "read-only", onEvent = () => {},
  onServerRequest, onRequestResolved = () => {}, onDiagnostic = () => {},
  startupTimeoutMs = 30000, requestTimeoutMs = 30000, shutdownTimeoutMs = 1500,
  maxLineBytes = 1024 * 1024 } = {}) {
  if (typeof executable !== "string" || !executable || typeof cwd !== "string" || !cwd) throw new Error("Codex executable and cwd are required.");
  if (!["read-only", "workspace-write"].includes(sandbox)) throw new Error("Unsupported Codex sandbox.");
  let child, started = false, closing, exited = false, terminal = false, fatalError;
  let threadId, turnId, usage, nextId = 0, lineBuffer = "", startupTimer, turnRevision = 0;
  let waitingTurn, continuing = false;
  const decoder = new StringDecoder("utf8");
  const completion = deferred(), exit = deferred();
  const calls = new Map(), pending = new Map(), completedItems = new Set();
  const asyncQuestions = new Map(), answeredQuestions = [];
  let exitInfo = { exitCode: null, signal: null };

  function callback(fn, value, second) {
    try { Promise.resolve(fn(value, second)).catch(fail); } catch (error) { fail(error); }
  }
  function emit(value) { callback(onEvent, value); }
  function resolved(id, reason) {
    if (!pending.delete(id)) return;
    asyncQuestions.delete(id);
    callback(onRequestResolved, { id, reason });
  }
  function clearPending(reason) { for (const id of pending.keys()) resolved(id, reason); }
  function rejectCalls(error) {
    for (const call of calls.values()) { clearTimeout(call.timer); call.reject(error); }
    calls.clear();
  }
  function killGroup(signal) {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  function fail(error) {
    if (fatalError || terminal) return;
    fatalError = error instanceof Error ? error : new Error(String(error));
    clearTimeout(startupTimer);
    rejectCalls(fatalError);
    clearPending("failed");
    completion.reject(fatalError);
    void close().catch(() => {});
  }
  function write(message) {
    if (!child || exited || closing || !child.stdin.writable) throw new Error("Codex app-server is not connected.");
    child.stdin.write(JSON.stringify(message) + "\n");
  }
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = `bridge-${++nextId}`;
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(new Error(`Codex app-server ${method} timed out.`));
      }, requestTimeoutMs);
      calls.set(id, { resolve, reject, timer });
      try { write({ id, method, params }); }
      catch (error) { clearTimeout(timer); calls.delete(id); reject(error); }
    });
  }
  function rememberThread(id) {
    if (typeof id !== "string" || !id) throw new Error("Codex app-server did not return a thread ID.");
    if (threadId && threadId !== id) throw new Error("Codex app-server changed the task thread.");
    if (!threadId) { threadId = id; emit({ type: "thread.started", thread_id: id }); }
  }
  function rememberTurn(id) {
    if (typeof id !== "string" || !id) throw new Error("Codex app-server did not return a turn ID.");
    if (turnId !== id) { turnId = id; turnRevision++; }
  }
  function emitItem(type, item) {
    if (!item || typeof item.type !== "string") return;
    if (type === "item.completed") {
      if (completedItems.has(item.id)) return;
      completedItems.add(item.id);
    }
    emit({ type, item: normalizedItem(item) });
    // Native request_user_input_async is an agent-message item, not a server
    // request. Its structured questions survive the turn's final message.
    if (type === "item.completed" && item.type === "agentMessage" && item.delivery === "async"
        && Array.isArray(item.questions) && item.questions.length) {
      const id = `bridge-async:${randomUUID()}`;
      const questions = item.questions.map((question, index) => ({ id: `question-${index + 1}`,
        header: `Question ${index + 1}`, question: question.title, isOther: true, isSecret: false,
        options: question.options == null ? null : question.options.map((label) => ({ label, description: "" })) }));
      if (!onServerRequest) throw new Error("This client cannot present asynchronous questions.");
      const request = { id, method: "item/tool/requestUserInput", params: {
        threadId, turnId, itemId: item.id, isBlocking: false, questions } };
      pending.set(id, request);
      asyncQuestions.set(id, questions);
      callback(onServerRequest, request);
    }
  }
  function finishTurn(turn) {
    terminal = true;
    waitingTurn = undefined;
    clearTimeout(startupTimer);
    clearPending("turn_completed");
    emit({ type: turn.status === "completed" ? "turn.completed" : turn.status === "interrupted" ? "turn.interrupted" : "turn.failed",
      ...(usage ? { usage } : {}), ...(turn.error ? { error: turn.error } : {}) });
    completion.resolve({ status: turn.status, threadId, turnId, usage, error: turn.error || null });
  }
  function continueOrFinish() {
    if (!waitingTurn || pending.size || continuing || terminal || fatalError || closing) return;
    if (!answeredQuestions.length) { finishTurn(waitingTurn); return; }
    continuing = true;
    waitingTurn = undefined;
    const answers = answeredQuestions.splice(0);
    // This is a new human-input turn in the existing thread. The original task
    // prompt is never replayed, and no turn starts without an explicit answer.
    const text = `Answers to your questions:\n${JSON.stringify(answers)}`;
    const revision = turnRevision;
    void rpc("turn/start", { threadId, input: [{ type: "text", text }] }).then((result) => {
      if (!result?.turn?.id) throw new Error("Codex app-server did not return a continuation turn ID.");
      // Notifications may advance the thread before a start response arrives.
      if (turnRevision === revision) rememberTurn(result.turn.id);
    }).catch(fail).finally(() => { continuing = false; continueOrFinish(); });
  }
  function notification(method, params = {}) {
    if (method === "serverRequest/resolved") { resolved(params.requestId, "server_resolved"); continueOrFinish(); return; }
    if (method === "thread/started") {
      // thread/start's response establishes the root; later child threads do not replace it.
      if (!threadId) rememberThread(params.thread?.id);
      return;
    }
    if (params.threadId !== threadId) return;
    if (method === "turn/started") { rememberTurn(params.turn?.id); waitingTurn = undefined; return; }
    if (method === "thread/tokenUsage/updated") {
      // Every job starts a fresh thread, so its cumulative usage includes all
      // model calls and human-answer continuations without double counting.
      const tokens = params.tokenUsage?.total || params.tokenUsage?.last;
      if (tokens) usage = { input_tokens: tokens.inputTokens, cached_input_tokens: tokens.cachedInputTokens,
        output_tokens: tokens.outputTokens, reasoning_output_tokens: tokens.reasoningOutputTokens,
        total_tokens: tokens.totalTokens };
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      if (!turnId || params.turnId === turnId) emitItem(method.replace("/", "."), params.item);
      return;
    }
    if (method !== "turn/completed" || terminal) return;
    const turn = params.turn;
    if (!turn || (turnId && turn.id !== turnId)) return;
    if (!["completed", "failed", "interrupted"].includes(turn.status)) throw new Error("Codex app-server returned an invalid terminal turn status.");
    rememberTurn(turn.id);
    for (const item of turn.items || []) emitItem("item.completed", item);
    if (turn.status === "completed" && (pending.size || answeredQuestions.length || continuing)) {
      waitingTurn = turn;
      continueOrFinish();
    } else finishTurn(turn);
  }
  function message(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex app-server message.");
    if (typeof value.method === "string") {
      if (Object.hasOwn(value, "id")) {
        if (typeof value.id !== "string" && !(typeof value.id === "number" && Number.isSafeInteger(value.id))) throw new Error("Invalid Codex server request ID.");
        if (terminal || fatalError) return;
        if (pending.has(value.id)) throw new Error("Codex app-server reused a pending request ID.");
        if (!onServerRequest) {
          write({ id: value.id, error: { code: -32601, message: "This client cannot present interactive requests." } });
          return;
        }
        const request = { id: value.id, method: value.method, params: value.params || {} };
        pending.set(value.id, request);
        callback(onServerRequest, request);
      } else notification(value.method, value.params);
      return;
    }
    const call = calls.get(value.id);
    if (!call) return;
    clearTimeout(call.timer); calls.delete(value.id);
    if (value.error) call.reject(new Error(`Codex app-server request failed: ${value.error.message || "unknown error"}`));
    else call.resolve(value.result);
  }
  function consume(chunk) {
    callback(onDiagnostic, "stdout", chunk);
    lineBuffer += decoder.write(chunk);
    let newline;
    while ((newline = lineBuffer.indexOf("\n")) !== -1) {
      const line = lineBuffer.slice(0, newline); lineBuffer = lineBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > maxLineBytes) throw new Error("Codex app-server message exceeds the output limit.");
      if (line.trim()) message(JSON.parse(line));
    }
    if (Buffer.byteLength(lineBuffer) > maxLineBytes) throw new Error("Codex app-server message exceeds the output limit.");
  }
  async function close() {
    if (closing) return closing;
    // Set the guard before callbacks run: clearing pending requests may cause
    // the supervisor to call close() again while updating its terminal state.
    closing = Promise.resolve().then(async () => {
      clearTimeout(startupTimer);
      rejectCalls(new Error("Codex app-server session closed."));
      clearPending("closed");
      if (!child) return;
      if (!terminal && !fatalError) {
        fatalError = new Error("Codex app-server session closed before turn completion.");
        completion.reject(fatalError);
      }
      child.stdin.end();
      // A dedicated process group includes MCP processes started by this session.
      killGroup("SIGTERM");
      const escalation = setTimeout(() => killGroup("SIGKILL"), shutdownTimeoutMs);
      await exit.promise;
      clearTimeout(escalation);
      killGroup("SIGKILL");
    });
    return closing;
  }
  async function start(prompt) {
    if (started) throw new Error("A Codex RPC session can start only one task.");
    if (closing) throw new Error("A closed Codex RPC session cannot start a task.");
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("A nonempty prompt is required.");
    started = true;
    child = spawn(executable, ["app-server", "--listen", "stdio://", "-c", "sandbox_workspace_write.writable_roots=[]"],
      { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", fail);
    child.stdout.on("data", (chunk) => { try { consume(chunk); } catch (error) { fail(error); } });
    child.stderr.on("data", (chunk) => callback(onDiagnostic, "stderr", chunk));
    child.once("error", (error) => { exited = true; exit.resolve(exitInfo); fail(error); });
    child.once("close", (code, signal) => {
      exited = true; exitInfo = { exitCode: code, signal };
      try {
        lineBuffer += decoder.end();
        if (lineBuffer.trim()) message(JSON.parse(lineBuffer));
      } catch (error) { fail(error); }
      exit.resolve(exitInfo);
      if (!terminal && !fatalError) fail(new Error("Codex app-server exited before turn completion."));
    });
    startupTimer = setTimeout(() => fail(new Error("Codex app-server startup timed out.")), startupTimeoutMs);
    try {
      await rpc("initialize", { clientInfo: { name: "shapes_bridge", title: "shapes.inc", version: "0.1.0" },
        capabilities: { experimentalApi: true, extensions: { "openai/form": {} } } });
      write({ method: "initialized", params: {} });
      const thread = await rpc("thread/start", { cwd, sandbox, approvalPolicy: "on-request", approvalsReviewer: "user" });
      rememberThread(thread.thread?.id);
      if (thread.approvalPolicy !== "on-request" || thread.approvalsReviewer !== "user") throw new Error("Codex did not enable human approval routing.");
      const revision = turnRevision;
      const turn = await rpc("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
      if (turnRevision === revision) rememberTurn(turn.turn?.id);
      if (!turnId) throw new Error("Codex app-server did not return a turn ID.");
      clearTimeout(startupTimer);
      const result = await completion.promise;
      await close();
      return { ...result, ...exitInfo };
    } catch (error) {
      fail(error);
      await close();
      throw fatalError || error;
    }
  }
  function respond(id, result) {
    if (!pending.has(id) || terminal || fatalError || closing) throw new Error("This Codex request is no longer pending.");
    if (asyncQuestions.has(id)) {
      const questions = asyncQuestions.get(id);
      if (!result || typeof result.answers !== "object" || result.answers === null) throw new Error("Invalid question response.");
      answeredQuestions.push(...questions.map((question) => ({ question: question.question,
        answers: result.answers[question.id]?.answers || [],
        ...(!Object.hasOwn(result.answers, question.id) ? { declined: true } : {}) })));
    } else write({ id, result });
    resolved(id, "answered");
    continueOrFinish();
  }
  async function interrupt() {
    if (terminal || exited) return;
    if (!threadId || !turnId) { await close(); return; }
    await rpc("turn/interrupt", { threadId, turnId });
  }
  return { start, respond, interrupt, close,
    get child() { return child; }, get threadId() { return threadId; }, get turnId() { return turnId; },
    get pendingRequests() { return [...pending.values()]; } };
}

module.exports = { createCodexRpcSession };
