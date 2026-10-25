"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPermissions, requestPermissions, automationState, fullDiskAccessState } = require("../src/permissions");
const { checklist, allGranted, guidedPermissionSetup } = require("../src/setup");

const granted = () => "granted";
const denied = () => "denied";

test("a broken or missing native preflight never claims computer permission", async () => {
  const status = await getPermissions({ platform: "darwin", execute: async () => { throw new Error("private native diagnostic"); }, fullDisk: () => "unknown" });
  assert.equal(status.accessibility, "unknown");
  assert.equal(status.screen_recording, "unknown");
  assert.equal(status.automation, "unknown");
  assert.equal(status.full_disk_access, "unknown");
  assert.ok(!JSON.stringify(status).includes("private native diagnostic"));
});

test("status checks never ask for OS permission; automation and disk access come from real probes", async () => {
  const calls = [];
  const status = await getPermissions({ platform: "darwin", fullDisk: denied, execute: async (file, args) => {
    calls.push({ file, args });
    return { stdout: JSON.stringify({ accessibility: "granted", screen_recording: "denied", automation_targets: [0, -600] }) };
  } });
  assert.equal(status.accessibility, "granted");
  assert.equal(status.screen_recording, "denied");
  assert.equal(status.automation, "granted");
  assert.equal(status.full_disk_access, "denied");
  assert.doesNotMatch(calls[0].args.join(" "), /RequestScreen|CheckOptionPrompt/);
  assert.match(calls[0].args.join(" "), /AEDeterminePermissionToAutomateTarget\(target\.aeDesc, 0x2A2A2A2A, 0x2A2A2A2A, false\)/);
});

test("automation state follows the per-app verdicts; disk access follows the protected-file probe", () => {
  assert.equal(automationState([0, 0]), "granted");
  assert.equal(automationState([0, -600]), "granted");
  assert.equal(automationState([-1744, 0]), "denied");
  assert.equal(automationState([-1743]), "denied");
  assert.equal(automationState([-600, -600]), "unknown");
  assert.equal(automationState(null), "unknown");
  assert.equal(fullDiskAccessState({ open: () => 3, close: () => {} }), "granted");
  assert.equal(fullDiskAccessState({ open: () => { const e = new Error("x"); e.code = "EPERM"; throw e; } }), "denied");
  assert.equal(fullDiskAccessState({ open: () => { throw new Error("odd"); } }), "unknown");
});

test("a single permission request invokes its native prompt; panel input is allowlisted", async () => {
  const calls = [];
  const execute = async (file, args) => {
    calls.push({ file, args });
    return { stdout: JSON.stringify({ accessibility: "denied", screen_recording: "denied", automation_targets: [-1744, -1744] }) };
  };
  const status = await requestPermissions({ platform: "darwin", permission: "accessibility", execute, fullDisk: denied });
  assert.equal(status.accessibility, "denied");
  assert.match(calls[0].args.join(" "), /CheckOptionPrompt/);
  assert.equal(calls[1].file, "/usr/bin/open");
  assert.match(calls[1].args[0], /Privacy_Accessibility$/);
  await assert.rejects(requestPermissions({ permission: "accessibility; unexpected", execute }), /Choose/);
  assert.equal(calls.length, 3);
});

test("setup asks for everything in one pass: both native prompts, detached automation prompts, and the Full Disk Access pane", async () => {
  const calls = []; const spawned = [];
  const execute = async (file, args) => { calls.push({ file, args }); return { stdout: JSON.stringify({ accessibility: "granted", screen_recording: "granted", automation_targets: [0, 0] }) }; };
  const spawnProcess = (file, args) => { spawned.push({ file, args }); return { on() {}, unref() {} }; };
  const status = await requestPermissions({ platform: "darwin", execute, spawnProcess, fullDisk: denied });
  assert.match(calls[0].args.join(" "), /CheckOptionPrompt/);
  assert.match(calls[0].args.join(" "), /CGRequestScreenCaptureAccess/);
  assert.equal(spawned.length, 1);
  assert.match(spawned[0].args.join(" "), /AEDeterminePermissionToAutomateTarget\(target\.aeDesc, 0x2A2A2A2A, 0x2A2A2A2A, true\)/);
  assert.match(spawned[0].args.join(" "), /com\.apple\.finder/);
  assert.equal(calls[1].file, "/usr/bin/open");
  assert.match(calls[1].args[0], /Privacy_AllFiles$/);
  assert.deepEqual(status, { accessibility: "granted", screen_recording: "granted", automation: "granted", full_disk_access: "denied" });
  // Already granted disk access does not reopen System Settings.
  calls.length = 0;
  await requestPermissions({ platform: "darwin", execute, spawnProcess, fullDisk: granted });
  assert.equal(calls.filter((call) => call.file === "/usr/bin/open").length, 0);
});

test("other platforms never run Mac permission commands or claim granted desktop access", async () => {
  for (const platform of ["win32", "linux"]) {
    const status = await requestPermissions({ platform, execute: async () => { assert.fail("unexpected OS command"); } });
    assert.equal(status.accessibility, "unsupported");
    assert.equal(status.screen_recording, "unsupported");
  }
});

test("guided setup asks once, polls without re-prompting, and stops when everything is allowed", async () => {
  const state = { status: { permissions: { accessibility: "denied", screen_recording: "denied", automation: "denied", full_disk_access: "denied" } } };
  const requests = []; const lines = [];
  let polls = 0;
  const result = await guidedPermissionSetup({
    platform: "darwin", pollMs: 1, log: (line) => lines.push(line),
    readState: (name) => state[name],
    writeState: (name, value) => { requests.push(value); if (value.probe && ++polls === 2) state.status = { permissions: { accessibility: "granted", screen_recording: "granted", automation: "granted", full_disk_access: "granted" } }; },
  });
  assert.deepEqual(requests[0], {});
  // After the one-shot prompts, the first missing pane is opened once; probes in between.
  assert.deepEqual(requests[1], { permission: "accessibility" });
  assert.ok(requests.slice(2).every((value) => value.probe === true || typeof value.permission === "string"));
  assert.equal(requests.filter((value) => value.permission === "accessibility").length, 1);
  assert.equal(allGranted(result), true);
  assert.match(lines.at(-1), /All computer permissions are set/);
  assert.match(checklist({ accessibility: "granted" }), /Keyboard & mouse: allowed\n  Screen recording: not checked/);
});

test("guided setup gives up after the deadline and names what is still missing", async () => {
  const lines = [];
  const result = await guidedPermissionSetup({ platform: "darwin", pollMs: 1, timeoutMs: 5, log: (line) => lines.push(line), readState: () => ({ permissions: { accessibility: "granted" } }), writeState: () => {} });
  assert.equal(allGranted(result), false);
  assert.match(lines.at(-1), /Still needed: Screen recording, Protected files, App control/);
});

test("guided setup walks the remaining panes in order, one pane per permission", async () => {
  const perms = { accessibility: "denied", screen_recording: "denied", automation: "granted", full_disk_access: "denied" };
  const requests = [];
  let probes = 0;
  await guidedPermissionSetup({
    platform: "darwin", pollMs: 1, timeoutMs: 200, log: () => {},
    readState: () => ({ permissions: { ...perms } }),
    writeState: (name, value) => {
      requests.push(value);
      if (value.probe) { probes++; if (probes === 1) perms.accessibility = "granted"; if (probes === 3) perms.screen_recording = "granted"; if (probes === 5) perms.full_disk_access = "granted"; }
    },
  });
  assert.deepEqual(requests.filter((value) => value.permission).map((value) => value.permission), ["accessibility", "screen_recording", "full_disk_access"]);
});
