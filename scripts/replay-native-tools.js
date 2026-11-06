"use strict";

// Opt-in: actual bundled app-server and Bridge HTTP/supervisor, a synthetic
// provider and capability service on loopback. No provider or app credentials.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const runtime = process.env.SHAPES_BUNDLED_CODEX_BINARY;
if (!runtime) throw new Error("Set SHAPES_BUNDLED_CODEX_BINARY to the pinned app-server.");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-native-tools-replay-"));
Object.assign(process.env, { SHAPES_BRIDGE_HOME: path.join(root, "state"), SHAPES_CODEX_JOB_DIR: path.join(root, "jobs") });
const { startServer } = require("../src/server");
const { getStatus, cancelJob } = require("../src/codex");
const plans = new Map(), calls = [], requests = [], jobs = [], results = [], operations = new Map(), crashCleanup = [];
let bridge, origin;
const service = http.createServer(async (req, res) => {
  try {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), token = req.headers.authorization?.replace(/^Bearer /, ""), plan = plans.get(token);
    assert(plan, "Only synthetic per-run grants accepted");
    if (req.url.startsWith("/bridge/native-tools/")) {
      assert.equal(token, plan.toolToken);
      assert.equal(body.run_id, plan.run_id);
      assert.equal(body.session_id, plan.session.session_id);
      assert.equal(body.request_key, plan.request_key);
      const action = req.url.split("/").at(-1); calls.push({ scenario: plan.name, action, body });
      let value;
      if (action === "discover") value = { capabilities: [{ capability_id: "fixture.read", description: "Synthetic text capability" }] };
      if (action === "describe") value = { capability_id: body.arguments.capability_id, name: "fixture_read", description: "Synthetic text capability",
        parameters: { type: "object", properties: { purpose: { type: "string" } }, required: ["purpose"], additionalProperties: false },
        provider: "fixture", schema_revision: "a".repeat(64) };
      if (action === "call") {
        const operation_id = body.arguments.operation_id;
        value = { operation_id, status: plan.hang ? "running" : "completed", tool_result: { text: "Synthetic result" } };
        operations.set(operation_id, { run_id: plan.run_id, session_id: plan.session.session_id, value });
        if (plan.hang) { plan.pending = true; return; }
      }
      if (action === "read" && !body.arguments.operation_id) value = { operations: [...operations.entries()]
        .filter(([, item]) => item.session_id === plan.session.session_id).slice(0, body.arguments.limit || 20)
        .map(([operation_id, item]) => ({ operation_id, status: item.value.status, capability_id: "fixture.read" })), next_cursor: null };
      else if (action === "read" || action === "cancel") {
        assert.equal(operations.get(body.arguments.operation_id)?.session_id, plan.session.session_id);
        value = operations.get(body.arguments.operation_id).value;
      }
      if (action === "cancel") { value = { operation_id: body.arguments.operation_id, status: "cancelled" }; operations.set(value.operation_id, { run_id: plan.run_id, session_id: plan.session.session_id, value }); }
      assert(value);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ success: true, result: value })); return;
    }
    assert.equal(token, plan.modelToken);
    plan.requests++;
    requests.push({ scenario: plan.name, body });
    const n = requests.length, code = plan.requests === 1 ? plan.code : plan.recover && plan.requests === 2
      ? `text(await tools.mcp__shapes__shapes_read_operation({operation_id:${JSON.stringify([...operations].find(([, item]) => item.run_id === (plan.recoverFrom || plan.run_id))[0])}}));` : undefined;
    const item = code ? { type: "custom_tool_call", id: `tool_${n}`, call_id: `call_${n}`, name: "exec", input: code }
      : { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Synthetic capability replay complete.", annotations: [] }] };
    const response = { id: `response_${n}`, object: "response", status: "completed", model: body.model, output: [item],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response }]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  } catch (error) { res.writeHead(500); res.end("Synthetic replay contract failed"); process.stderr.write(String(error) + "\n"); }
});
async function api(route, body) {
  const response = await fetch(origin + route, { method: body ? "POST" : "GET", headers: { "x-token": "synthetic-bridge", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
}
async function waitUntil(predicate, milliseconds = 12000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error("Replay deadline expired");
}
async function start(name, session, { code, disabled = false, hang = false, recover = false, crash = false, recoverFrom } = {}) {
  const plan = { name, session, code, hang, recover, recoverFrom, requests: 0, request_key: randomUUID(), run_id: randomUUID(), modelToken: "model-" + randomUUID(), toolToken: "tool-" + randomUUID() };
  plans.set(plan.modelToken, plan); plans.set(plan.toolToken, plan);
  const identity = { session_id: session.session_id, scope_id: session.scope_id, request_key: plan.request_key, run_id: plan.run_id, expires_at: Date.now() / 1000 + 600 };
  const base = `http://127.0.0.1:${service.address().port}`;
  const gateway = { ...identity, token: plan.modelToken, model: "gpt-6-astra", base_url: base + "/v1",
    ...(!disabled ? { tool_proxy: { ...identity, version: 1, token: plan.toolToken, base_url: base + "/bridge/native-tools" } } : {}) };
  plan.job = await api("/agents/start", { session_id: session.session_id, scope_id: session.scope_id, request_key: plan.request_key, gateway, prompt: `Synthetic ${name} fixture` });
  jobs.push(plan.job.job_id);
  if (hang) {
    await waitUntil(() => plan.pending);
    if (crash) {
      const owned = JSON.parse(fs.readFileSync(path.join(root, "jobs", plan.job.job_id, "state.json"), "utf8"));
      assert.equal(owned.id, plan.job.job_id); assert(owned.agentPid && owned.supervisorPid);
      const processTree = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
      const descendants = new Set([owned.agentPid]);
      for (let changed = true; changed;) {
        changed = false;
        for (const [pid, ppid] of processTree) if (descendants.has(ppid) && !descendants.has(pid)) { descendants.add(pid); changed = true; }
      }
      const exited = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; } };
      process.kill(owned.supervisorPid, "SIGKILL");
      let automaticExit = true;
      try { await waitUntil(() => [owned.supervisorPid, ...descendants].every(exited), 2000); }
      catch {
        automaticExit = false;
        try { process.kill(-owned.agentPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        await waitUntil(() => [owned.supervisorPid, ...descendants].every(exited));
      }
      assert(owned.toolBrokerDirectory.startsWith("/tmp/shapes-native-tools-"));
      assert.equal(fs.statSync(owned.toolBrokerDirectory).uid, process.getuid());
      fs.rmSync(owned.toolBrokerDirectory, { recursive: true, force: true });
      crashCleanup.push({ native_descendants: descendants.size, exited_after_supervisor_only_loss: automaticExit, broker_directory_removed_by_fixture: true });
    } else await api("/agents/cancel", { job_id: plan.job.job_id });
  }
  let state;
  await waitUntil(() => { state = getStatus(plan.job.job_id); return ["completed", "failed", "cancelled", "timed_out"].includes(state.state); });
  assert.equal(state.state, crash ? "failed" : hang ? "cancelled" : "completed", JSON.stringify(state));
  results.push({ scenario: name, state: state.state, thread_id: state.thread_id, model_requests: plan.requests });
  return plan;
}
function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
}
(async () => {
  try {
    await new Promise(resolve => service.listen(0, "127.0.0.1", resolve));
    bridge = await startServer({ port: 0, token: "synthetic-bridge" }); origin = `http://127.0.0.1:${bridge.address().port}`;
    assert.equal((await api("/capabilities")).features.native_tool_proxy, true);
    const cwd = path.join(root, "workspace"); fs.mkdirSync(cwd);
    const session = { session_id: randomUUID(), scope_id: randomUUID(), cwd, workspace_write: false, funding: "shapes_credits" };
    await api("/sessions/create", session);
    await start("original-browser-composition", session, { code: 'text(ALL_TOOLS.filter(tool=>tool.name.startsWith("mcp__shapes__"))); text(await tools.mcp__shapes__shapes_discover({query:"browser"})); text(await tools.mcp__shapes__shapes_describe({capability_id:"fixture.read"})); text(await tools.mcp__shapes__shapes_call({capability_id:"fixture.read",schema_revision:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",arguments:{purpose:"inspect browser"}}));' });
    await start("connected-document-composition", session, { code: 'text(await tools.mcp__shapes__shapes_discover({query:"documents"})); text(await tools.mcp__shapes__shapes_describe({capability_id:"fixture.read"})); text(await tools.mcp__shapes__shapes_call({capability_id:"fixture.read",schema_revision:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",arguments:{purpose:"read document"}}));' });
    await start("operation-recovery-composition", session, { recover: true, code: 'text(await tools.mcp__shapes__shapes_call({capability_id:"fixture.read",schema_revision:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",arguments:{purpose:"recover receipt"}}));' });
    await start("feature-disabled-resume", session, { disabled: true, code: 'text(await tools.mcp__shapes__shapes_discover({query:"must not execute"}));' });
    assert.equal(calls.filter(value => value.scenario === "feature-disabled-resume").length, 0);
    await start("cancel-pending-operation", session, { hang: true, code: 'text(await tools.mcp__shapes__shapes_call({capability_id:"fixture.read",schema_revision:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",arguments:{purpose:"wait"}}));' });
    assert.equal(calls.filter(value => value.scenario === "cancel-pending-operation" && value.action === "cancel").length, 1);
    assert.equal(results.at(-1).model_requests, 1);
    const lost = await start("supervisor-loss-after-admission", session, { hang: true, crash: true,
      code: 'text(await tools.mcp__shapes__shapes_call({capability_id:"fixture.read",schema_revision:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",arguments:{purpose:"lost receipt"}}));' });
    await start("recover-after-supervisor-loss", session, { recover: true, recoverFrom: lost.run_id,
      code: 'text(await tools.mcp__shapes__shapes_read_operation({limit:20}));' });
    assert.equal(calls.filter(value => value.scenario === lost.name && value.action === "call").length, 1);
    assert.equal(calls.filter(value => value.scenario === "recover-after-supervisor-loss" && value.action === "call").length, 0);
    assert.equal(new Set(results.map(value => value.thread_id)).size, 1, "Native conversation is resumed");
    const enabledPrompt = strings(requests[0].body.input[0]).join("\n");
    const disabledPrompt = strings(requests.find(value => value.scenario === "feature-disabled-resume").body.input[0]).join("\n");
    const resumedDisabledSchemaRetained = disabledPrompt.includes("### `shapes_discover`");
    // MCP discovery follows the current runtime configuration on resume.
    assert.equal(resumedDisabledSchemaRetained, false);
    const legacy = { ...session, session_id: randomUUID(), scope_id: randomUUID() };
    await api("/sessions/create", legacy);
    await start("legacy-default-off", legacy, { disabled: true });
    await start("legacy-enable-at-resume", legacy, { code: 'text(await tools.mcp__shapes__shapes_discover({query:"available after enabling"}));' });
    const legacyPrompt = strings(requests.find(value => value.scenario === "legacy-enable-at-resume").body.input[0]).join("\n");
    assert.equal(legacyPrompt.includes("### `shapes_discover`"), false);
    assert.equal(calls.filter(value => value.scenario === "legacy-enable-at-resume").length, 1);
    const discovered = strings(requests[1].body.input).map(text => { try { return JSON.parse(text); } catch { return null; } })
      .find(value => Array.isArray(value) && value.length === 5 && value.every(tool => tool.name?.startsWith("mcp__shapes__")));
    assert(discovered, "The actual runtime exposes all five tool contracts through discovery");
    for (const keyword of ["browser", "app", "docs", "document"]) assert(discovered.some(tool => tool.name.endsWith("shapes_discover") && tool.description.includes(keyword)), `Native keyword search finds ${keyword}`);
    const renderedSchema = JSON.stringify(discovered);
    for (const plan of new Set(plans.values())) {
      const stored = fs.readFileSync(path.join(root, "jobs", plan.job.job_id, "request.json"), "utf8");
      assert.equal(stored.includes(plan.toolToken), false);
      assert.equal(JSON.stringify(requests).includes(plan.toolToken), false);
    }
    if (process.env.SHAPES_NATIVE_TOOLS_CAPTURE) fs.writeFileSync(process.env.SHAPES_NATIVE_TOOLS_CAPTURE, JSON.stringify({simulated_provider:true,requests,capability_requests:calls},null,2), {mode:0o600,flag:"wx"});
    const report = { simulated_provider: true, simulated_capabilities: true, scenarios: results,
      model_requests: requests.length, capability_requests: calls.length, resumed_disabled_schema_retained: resumedDisabledSchemaRetained,
      crash_cleanup: crashCleanup,
      legacy_resume_adds_tools: true, initial_schema_bytes: 0, rendered_schema_bytes: Buffer.byteLength(renderedSchema), rendered_schema: renderedSchema };
    if (process.env.SHAPES_NATIVE_TOOLS_REPORT) fs.writeFileSync(process.env.SHAPES_NATIVE_TOOLS_REPORT, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ ...report, rendered_schema: undefined }, null, 2));
  } catch (error) {
    if (process.env.SHAPES_NATIVE_TOOLS_CAPTURE) fs.writeFileSync(process.env.SHAPES_NATIVE_TOOLS_CAPTURE + ".failed", JSON.stringify({ simulated_provider: true, requests, calls,
      diagnostics: jobs.map(id => ({ id, stderr: fs.existsSync(path.join(root, "jobs", id, "stderr.log")) ? fs.readFileSync(path.join(root, "jobs", id, "stderr.log"), "utf8") : "" })) }, null, 2), { mode: 0o600 });
    throw error;
  } finally {
    for (const id of jobs) { try { cancelJob(id); } catch {} }
    if (bridge) { bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve)); }
    service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
