"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
// Opt-in regression: real pinned local tools, only a loopback fake provider.
// SHAPES_BRIDGE_SOURCE can select a packaged Resources/runtime directory.
const bridgeSource = process.env.SHAPES_BRIDGE_SOURCE || path.resolve(__dirname, '..');
const runtime = process.env.SHAPES_BUNDLED_CODEX_BINARY || require(path.join(bridgeSource, 'src/bundled-runtime')).bundledRuntime().executable;
if (!runtime) throw new Error('Set SHAPES_BUNDLED_CODEX_BINARY to the pinned app-server executable.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-session-canary-"));
process.env.SHAPES_BRIDGE_HOME = path.join(root, "state");
process.env.SHAPES_CODEX_JOB_DIR = path.join(root, "jobs");
process.env.SHAPES_BUNDLED_CODEX_BINARY = runtime;
const { startServer } = require(path.join(bridgeSource, "src/server"));
const { cancelJob, getStatus } = require(path.join(bridgeSource, "src/codex"));
const { cleanupReplay } = require("./replay-cleanup");
const plans = new Map(), receipts = [], requests = [], jobs = [];
let bridge, origin;
const modelServer = http.createServer(async (req, res) => {
  try {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), token = req.headers.authorization?.replace(/^Bearer /, "");
    const plan = plans.get(token); assert(plan);
    plan.calls++;
    requests.push({ scenario: plan.name, call: plan.calls, body });
    if (plan.stall) { plan.started?.(); return; }
    if (plan.overflow && plan.calls === 2) {
      // Exact billed-gateway overflow wire. The rejection is injected here;
      // separate gateway tests enforce serialized UTF-8 byte/reservation caps.
      const failed = { type: "response.failed", sequence_number: 0, response: {
        id: "sandbox-rejected", object: "response", status: "failed", error: {
          type: "invalid_request_error", code: "context_length_exceeded",
          message: "Sandbox request exceeds 262144 UTF-8 bytes. Compact the conversation or reduce tool output.",
        }, output: [], usage: null,
      } };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.end(`event: response.failed\ndata: ${JSON.stringify(failed)}\n\n`);
      return;
    }
    const n = requests.length;
    const code = plan.calls === 1 ? plan.code : null;
    const item = code ? {
      type: "custom_tool_call", id: `tool_${n}`, call_id: `call_${n}`, name: "exec", input: code,
    } : { type: "message", id: `msg_${n}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: `${plan.name} fixture complete.`, annotations: [] }] };
    const response = { id: `resp_${n}`, object: "response", status: "completed", model: body.model, output: [item],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const data of [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ]) res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
async function api(route, body, token = "synthetic-bridge-token") {
  const response = await fetch(origin + route, { method: body ? "POST" : "GET", headers: { "x-token": token, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  return { status: response.status, value };
}
async function startBridge() { bridge = await startServer({ port: 0, token: "synthetic-bridge-token" }); origin = `http://127.0.0.1:${bridge.address().port}`; }
async function stopBridge() { bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve)); }
async function create(name, write = true) {
  const cwd = path.join(root, name); fs.mkdirSync(cwd);
  const session = { session_id: randomUUID(), scope_id: randomUUID(), cwd, workspace_write: write, funding: "shapes_credits" };
  const result = await api("/sessions/create", session); assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.value.turn_count, 0); assert.equal(requests.length, receipts.reduce((n, item) => n + item.calls, 0));
  return session;
}
async function run(session, name, code, options = {}) {
  const requestKey = randomUUID(), token = `fixture-${randomUUID()}`;
  const plan = { name, code, calls: 0, ...options }; plans.set(token, plan);
  const body = { session_id: session.session_id, scope_id: session.scope_id,
    ...(options.input ? { input: options.input } : { prompt: name }), request_key: requestKey,
    gateway: { token, session_id: session.session_id, scope_id: session.scope_id, request_key: requestKey,
      base_url: `http://127.0.0.1:${modelServer.address().port}/v1`, model: "gpt-6-astra", run_id: randomUUID(), expires_at: new Date(Date.now() + 120000).toISOString() } };
  const started = await api("/agents/start", body); assert.equal(started.status, 202, JSON.stringify(started));
  jobs.push(started.value.job_id);
  const duplicate = await api("/agents/start", body); assert.equal(duplicate.value.job_id, started.value.job_id); assert.equal(duplicate.value.deduplicated, true);
  let result; const deadline = Date.now() + 30000;
  do { result = (await api(`/agents/status?job_id=${started.value.job_id}`)).value;
    if (["completed", "failed", "cancelled", "timed_out"].includes(result.state)) break;
  } while (Date.now() < deadline);
  assert.equal(result.state, options.expectedState || "completed", JSON.stringify(result));
  const events = (await api(`/sessions/events?session_id=${session.session_id}&scope_id=${session.scope_id}`)).value;
  receipts.push({ name, result, calls: plan.calls, events });
  return result;
}
function patch(file, content) { return `text(await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Add File: ${file}\n${content.split("\n").map(line => "+" + line).join("\n")}\n*** End Patch`)}));`; }
function command(cmd) { return `text(await tools.exec_command(${JSON.stringify({ cmd, login: false, max_output_tokens: 500 })}));`; }
function inputImages(value) {
  if (Array.isArray(value)) return value.flatMap(inputImages);
  if (!value || typeof value !== "object") return [];
  return value.type === "input_image" ? [value] : Object.values(value).flatMap(inputImages);
}
(async () => {
  try {
    await new Promise(resolve => modelServer.listen(0, "127.0.0.1", resolve)); await startBridge();
    assert.equal((await api("/sessions/read?session_id=bad", null, "wrong-token")).status, 401);
    const coding = await create("code");
    await run(coding, "JavaScript create and run", patch("multiply.js", "require('node:fs').writeFileSync('code-result.txt', String(4 * 10));") + command("node multiply.js"));
    assert.equal(fs.readFileSync(path.join(coding.cwd, "code-result.txt"), "utf8"), "40");
    const html = await create("files");
    const first = await run(html, "HTML file creation", patch("packing.html", "<!doctype html><title>Weekend packing</title><h1>Weekend packing</h1><label><input type=checkbox>Charger</label>"));
    assert.match(fs.readFileSync(path.join(html.cwd, "packing.html"), "utf8"), /Charger/);
    await stopBridge(); await startBridge();
    const resumed = await run(html, "Follow-up after Bridge restart", command("node -e \"const fs=require('node:fs');const p='packing.html';fs.appendFileSync(p,'<label><input type=checkbox>Passport</label>')\""));
    assert.equal(resumed.thread_id, first.thread_id);
    assert.match(fs.readFileSync(path.join(html.cwd, "packing.html"), "utf8"), /Passport/);
    const screenshots = await create("original-screenshot");
    const originalText = "Fix the flicker shown here.\nKeep this exact original request.";
    const originalURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
    const originalInput = [{ type: "text", text: originalText, context_key: "source-original:0" },
      { type: "image", url: originalURL, context_key: "source-original:1" },
      { type: "text", text: "Use the current project and verify the outcome." }];
    const screenshot = await run(screenshots, "Original screenshot input", patch("verified-input.txt", "original input reached pinned runtime"), { input: originalInput });
    assert.equal(fs.readFileSync(path.join(screenshots.cwd, "verified-input.txt"), "utf8"), "original input reached pinned runtime\n");
    const originalRequest = requests.find((request) => request.scenario === "Original screenshot input").body;
    assert.ok(JSON.stringify(originalRequest.input).includes(JSON.stringify(originalText).slice(1, -1)));
    const images = inputImages(originalRequest.input);
    assert.equal(images.length, 1);
    assert.equal(images[0].image_url, originalURL);
    receipts.at(-1).input_images = images;
    await stopBridge(); await startBridge();
    const followupURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEElEQVR4nGNgYPiPAw0pCQCpcD/BFMrqcwAAAABJRU5ErkJggg==";
    const screenshotFollowup = await run(screenshots, "Screenshot follow-up", null, {
      input: [{ type: "text", text: "Compare this follow-up with my original screenshot." }, { type: "image", url: followupURL }],
    });
    assert.equal(screenshotFollowup.thread_id, screenshot.thread_id);
    const followupImages = inputImages(requests.find((request) => request.scenario === "Screenshot follow-up").body.input);
    assert.deepEqual(followupImages.map((image) => image.image_url), [originalURL, followupURL]);
    receipts.at(-1).input_images = followupImages;
    for (let index = 0; index < 5; index++) {
      if (index === 2) { await stopBridge(); await startBridge(); }
      const name = `Repeated screenshot context follow-up ${index + 1}`;
      const result = await run(screenshots, name, null, { input: [
        ...originalInput.slice(0, 2), { type: "text", text: `Continue verification step ${index + 1}.` },
      ] });
      assert.equal(result.thread_id, screenshot.thread_id);
      const request = requests.find((request) => request.scenario === name).body;
      const retainedImages = inputImages(request.input);
      assert.deepEqual(retainedImages.map((image) => image.image_url), [originalURL, followupURL]);
      assert.equal(JSON.stringify(request.input).split(JSON.stringify(originalText).slice(1, -1)).length - 1, 1);
      assert.equal(JSON.stringify(request).includes("context_key"), false);
      receipts.at(-1).input_images = retainedImages;
    }
    const delivered = await api(`/sessions/read?${new URLSearchParams({ session_id: screenshots.session_id, scope_id: screenshots.scope_id })}`);
    assert.equal(delivered.value.context_thread_id, screenshot.thread_id);
    assert.deepEqual(delivered.value.delivered_context_keys.sort(), ["source-original:0", "source-original:1"]);
    const localImages = await create("local-image-view");
    const localImage = path.join(localImages.cwd, "fixture.png");
    fs.writeFileSync(localImage, Buffer.from(originalURL.split(",")[1], "base64"));
    await run(localImages, "Local image verification", `image((await tools.view_image({path:${JSON.stringify(localImage)}})).image_url);`);
    const viewedImages = inputImages(requests.filter((request) => request.scenario === "Local image verification").at(-1).body.input);
    assert.equal(viewedImages.length, 1);
    receipts.at(-1).input_images = viewedImages;
    receipts.at(-1).image_locations = requests.filter((request) => request.scenario === "Local image verification").at(-1).body.input
      .filter((item) => inputImages(item).length).map((item) => ({ type: item.type, role: item.role,
        content_types: Array.isArray(item.content) ? item.content.map((part) => part.type) : undefined,
        output_types: Array.isArray(item.output) ? item.output.map((part) => part.type) : undefined }));
    const csv = await create("data");
    await run(csv, "CSV analysis", patch("costs.csv", "item,amount\nTrain,12\nDinner,8") + command("node -e \"const fs=require('node:fs');const total=fs.readFileSync('costs.csv','utf8').trim().split('\\n').slice(1).reduce((sum,row)=>sum+Number(row.split(',')[1]),0);fs.writeFileSync('total.json',JSON.stringify({total}));\""));
    assert.equal(JSON.parse(fs.readFileSync(path.join(csv.cwd, "total.json"), "utf8")).total, 20);
    const readonly = await create("read-only", false);
    await run(readonly, "Read-only write refusal", patch("must-not-exist.txt", "no"));
    assert.equal(fs.existsSync(path.join(readonly.cwd, "must-not-exist.txt")), false);
    const overflow = await create("overflow-rejection");
    const overflowResult = await run(overflow, "Gateway overflow rejection", 'text("synthetic tool output ".repeat(1000));', {
      overflow: true, expectedState: "failed",
    });
    assert.equal(overflowResult.error_type, "agent_error");
    assert.match(overflowResult.error, /context window/);
    const overflowReceipt = receipts.at(-1);
    assert.equal(overflowReceipt.calls, 2, "One tool request and one overflow rejection; no hidden compaction or start retry");
    const overflowState = fs.readFileSync(path.join(process.env.SHAPES_CODEX_JOB_DIR, jobs.at(-1), "events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(overflowState.filter(event => event.type === "item.completed" && event.item?.type === "contextCompaction").length, 0);
    assert.equal(overflowState.filter(event => event.type === "turn.failed").length, 1);
    // Observe natural terminal cleanup before the finally block can send cancel.
    const failedState = JSON.parse(fs.readFileSync(path.join(process.env.SHAPES_CODEX_JOB_DIR, jobs.at(-1), "state.json"), "utf8"));
    const processAlive = pid => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; throw error; }
    };
    assert.ok(Number.isInteger(failedState.agentPid) && Number.isInteger(failedState.supervisorPid));
    const cleanupDeadline = Date.now() + 3000;
    while ((processAlive(failedState.agentPid) || processAlive(failedState.supervisorPid)) && Date.now() < cleanupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(processAlive(failedState.agentPid), false, "failed agent exited before cleanup");
    assert.equal(processAlive(failedState.supervisorPid), false, "failed supervisor exited before cleanup");
    if (process.platform !== "win32") assert.equal(processAlive(-failedState.agentPid), false, "failed task process group exited");
    overflowReceipt.terminal_cleanup = { agent_pid: failedState.agentPid, supervisor_pid: failedState.supervisorPid,
      agent_exited: true, supervisor_exited: true, process_group_exited: process.platform === "win32" ? null : true,
      observed_before_final_cleanup: true };
    const rejected = await api(`/sessions/read?session_id=${html.session_id}&scope_id=${randomUUID()}`); assert.equal(rejected.status, 403);
    const persisted = (await api(`/sessions/read?session_id=${html.session_id}&scope_id=${html.scope_id}`)).value;
    assert.equal(persisted.turn_count, 2);
    const cancelled = await create("cancel-stalled-provider");
    const cancelKey = randomUUID(), cancelToken = `fixture-${randomUUID()}`;
    let startedResolve;
    const providerStarted = new Promise(resolve => { startedResolve = resolve; });
    const cancelPlan = { name: "Cancel stalled provider", stall: true, calls: 0, started: startedResolve };
    plans.set(cancelToken, cancelPlan);
    const cancelBody = { session_id: cancelled.session_id, scope_id: cancelled.scope_id, prompt: "Wait for a response", request_key: cancelKey,
      gateway: { token: cancelToken, session_id: cancelled.session_id, scope_id: cancelled.scope_id, request_key: cancelKey,
        base_url: `http://127.0.0.1:${modelServer.address().port}/v1`, model: "gpt-6-astra", run_id: randomUUID(), expires_at: Math.floor(Date.now() / 1000) + 120 } };
    const cancelReceipt = await api("/agents/start", cancelBody);
    assert.equal(cancelReceipt.status, 202); jobs.push(cancelReceipt.value.job_id);
    await Promise.race([providerStarted, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Provider did not start")), 30000); timer.unref(); })]);
    const recovered = await api(`/agents/jobs?request_key=${cancelKey}`);
    assert.equal(recovered.value.jobs[0].job_id, cancelReceipt.value.job_id);
    const cancelResult = await api("/agents/cancel", { job_id: cancelReceipt.value.job_id });
    assert.equal(cancelResult.status, 200);
    let cancelStatus; const cancelDeadline = Date.now() + 10000;
    do { cancelStatus = (await api(`/agents/status?job_id=${cancelReceipt.value.job_id}`)).value;
      if (cancelStatus.state === "cancelled") break;
    } while (Date.now() < cancelDeadline);
    assert.equal(cancelStatus.state, "cancelled");
    assert.equal(cancelPlan.calls, 1);
    receipts.push({ name: cancelPlan.name, result: cancelStatus, calls: cancelPlan.calls });
    const out = { version: "0.166.0", simulated_provider: true, real_local_execution: true, receipts, requests,
      request_envelopes: requests.map((request) => ({ scenario: request.scenario, call: request.call,
        bytes: Buffer.byteLength(JSON.stringify(request.body)), image_count: inputImages(request.body.input).length })),
      assertions: ["unauthorized access rejected", "three compositions persisted", "original text and inline image reached pinned runtime/provider", "image history resumed after Bridge restart", "local view_image reached provider as image input", "duplicate send reused job", "follow-up resumed same thread after Bridge restart", "read-only edit refused", "gateway overflow failed truthfully without hidden retry", "wrong scope rejected", "raw request key recovers job", "numeric expiry accepted", "stalled provider cancelled without retry"] };
    if (process.env.SHAPES_CANARY_REPORT) fs.writeFileSync(process.env.SHAPES_CANARY_REPORT, JSON.stringify({ ...out, requests: undefined }, null, 2));
    // Explicit local-only evidence for replay through the billing gateway.
    // Captures include runtime prompts; never commit or publish this file.
    if (process.env.SHAPES_CANARY_CAPTURE) fs.writeFileSync(process.env.SHAPES_CANARY_CAPTURE,
      JSON.stringify({ version: out.version, simulated_provider: true, requests }, null, 2), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ success: true, scenarios: receipts.map(r => ({ name: r.name, state: r.result.state, calls: r.calls, usage: r.result.usage })), assertions: out.assertions }));
  } catch (error) {
    if (process.env.SHAPES_CANARY_REPORT) fs.writeFileSync(process.env.SHAPES_CANARY_REPORT, JSON.stringify({ error: String(error), receipts }, null, 2));
    console.error(String(error)); process.exitCode = 1;
  } finally {
    await cleanupReplay({ jobs, cancelJob, servers: [bridge, modelServer], root, getState(id) {
      return { ...JSON.parse(fs.readFileSync(path.join(root, "jobs", id, "state.json"), "utf8")), status: getStatus(id).state };
    } });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
