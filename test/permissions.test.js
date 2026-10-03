"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPermissions, requestPermissions } = require("../src/permissions");

test("a broken or missing native preflight never claims computer permission", async () => {
  const status = await getPermissions({ platform: "darwin", execute: async () => { throw new Error("private native diagnostic"); } });
  assert.equal(status.accessibility, "unknown");
  assert.equal(status.screen_recording, "unknown");
  assert.equal(status.full_disk_access, "unknown");
  assert.ok(!JSON.stringify(status).includes("private native diagnostic"));
});

test("status checks never ask for OS permission and cannot infer a blanket disk or app grant", async () => {
  const calls = [];
  const status = await getPermissions({ platform: "darwin", execute: async (file, args) => {
    calls.push({ file, args });
    return { stdout: JSON.stringify({ accessibility: "granted", screen_recording: "denied" }) };
  } });
  assert.equal(status.accessibility, "granted");
  assert.equal(status.screen_recording, "denied");
  assert.equal(status.automation, "unknown");
  assert.equal(status.full_disk_access, "unknown");
  assert.doesNotMatch(calls[0].args.join(" "), /RequestScreen|CheckOptionPrompt/);
});

test("an explicit setup request invokes native prompts; panel input is allowlisted", async () => {
  const calls = [];
  const execute = async (file, args) => {
    calls.push({ file, args });
    return { stdout: JSON.stringify({ accessibility: "denied", screen_recording: "denied" }) };
  };
  const status = await requestPermissions({ platform: "darwin", permission: "accessibility", execute });
  assert.equal(status.accessibility, "denied");
  assert.match(calls[0].args.join(" "), /CheckOptionPrompt/);
  assert.equal(calls[1].file, "/usr/bin/open");
  assert.match(calls[1].args[0], /Privacy_Accessibility$/);
  await assert.rejects(requestPermissions({ permission: "accessibility; unexpected", execute }), /Choose/);
  assert.equal(calls.length, 3);
});

test("other platforms never run Mac permission commands or claim granted desktop access", async () => {
  for (const platform of ["win32", "linux"]) {
    const status = await requestPermissions({ platform, execute: async () => { assert.fail("unexpected OS command"); } });
    assert.equal(status.accessibility, "unsupported");
    assert.equal(status.screen_recording, "unsupported");
  }
});
