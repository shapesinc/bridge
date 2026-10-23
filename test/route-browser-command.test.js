"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CONSENT, routeBrowserCommand } = require("../src/browser-route/command");
const { readState, writeState } = require("../src/state");

const SAVED = { api: "https://api.shapes.inc", device_id: "computer", device_token: "saved-identity", name: "My computer", keep_awake: true };

async function isolated(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-route-"));
  const previous = process.env.SHAPES_BRIDGE_HOME;
  process.env.SHAPES_BRIDGE_HOME = dir;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The command with real config storage and recorded API calls, restarts and output. */
function harness({ config = SAVED, answer = "", respond = async () => ({ success: true, enabled: true, relay_url: "wss://device-relay.shapes.inc/device", relay_token: "v1.x.y", expires_in: 43200 }) } = {}) {
  writeState("config", config);
  const events = [], output = [], asked = [];
  const run = (action, yes = false) => routeBrowserCommand({
    action, yes, config: readState("config"),
    request: async (api, route, body, token, method) => { events.push({ request: { api, route, body, token, method } }); return respond(body); },
    writeConfig: (next) => { events.push({ write: next.route_browser }); writeState("config", next); },
    restart: () => events.push("restart"),
    ask: async (question) => { asked.push(question); return answer; },
    log: (line) => output.push(line),
  });
  return { run, events, output, asked };
}

test("turning it on shows the consent text and changes nothing without an explicit yes", () => isolated(async () => {
  for (const answer of ["", "n", "sure", "no"]) {
    const { run, events, output, asked } = harness({ answer });
    assert.equal(await run("on"), false);
    assert.equal(output[0], CONSENT);
    assert.equal(asked.length, 1);
    assert.deepEqual(events, [], answer);
    assert.equal(readState("config").route_browser, undefined);
  }
}));

test("a yes tells shapes.inc, saves the choice and restarts the background connection", () => isolated(async () => {
  for (const [answer, yes] of [["y", false], ["", true]]) {
    const { run, events, asked } = harness({ answer });
    assert.equal(await run("on", yes), true);
    assert.equal(asked.length, yes ? 0 : 1);
    assert.deepEqual(events, [
      { request: { api: "https://api.shapes.inc", route: "/devices/browser-route", body: { enabled: true }, token: "saved-identity", method: undefined } },
      { write: true },
      "restart",
    ]);
    assert.equal(readState("config").route_browser, true);
    assert.equal(readState("config").device_token, "saved-identity");
  }
}));

test("when shapes.inc doesn't offer it yet, its reason is shown and nothing is enabled", () => isolated(async () => {
  const notAvailable = Object.assign(new Error("HTTP 403"), { status: 403, body: { success: false, code: "not_available", error: "Not on your account yet.\u001b[2J" } });
  const { run, events } = harness({ respond: async () => { throw notAvailable; } });
  await assert.rejects(run("on", true), { message: "Not on your account yet." });
  assert.equal(events.length, 1);
  assert.equal(readState("config").route_browser, undefined);

  const offline = harness({ respond: async () => { throw new Error("fetch failed"); } });
  await assert.rejects(offline.run("on", true), /nothing changed/);
  assert.equal(readState("config").route_browser, undefined);
}));

test("off is the kill switch: it stops locally first and doesn't need the network", () => isolated(async () => {
  const { run, events, output } = harness({ config: { ...SAVED, route_browser: true }, respond: async () => { throw new Error("fetch failed"); } });
  assert.equal(await run("off"), false);
  assert.deepEqual(events, [
    { write: false },
    "restart",
    { request: { api: "https://api.shapes.inc", route: "/devices/browser-route", body: { enabled: false }, token: "saved-identity", method: "POST" } },
  ]);
  assert.equal(readState("config").route_browser, false);
  assert.match(output.at(-1), /^Off\./);

  // A removed computer still turns it off locally, without calling shapes.inc with a dead credential.
  const removed = harness({ config: { ...SAVED, route_browser: true, revoked: true } });
  await removed.run("off");
  assert.deepEqual(removed.events, [{ write: false }]);
}));
