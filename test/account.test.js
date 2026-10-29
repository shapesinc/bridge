"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { pairDevice, validateApi, apiRequest } = require("../src/account");

test("persistent secrets require HTTPS except explicitly local development", () => {
  assert.equal(validateApi("https://api.shapes.inc/"), "https://api.shapes.inc");
  assert.equal(validateApi("http://127.0.0.1:8000"), "http://127.0.0.1:8000");
  for (const url of ["http://evil.example", "https://user:password@example.com", "https://example.com/?token=bad", "file:///tmp/foo"]) {
    assert.throws(() => validateApi(url));
  }
});

test("pairing approval URL/code are public, device credential is obtained only by private poll", async () => {
  const requests = [];
  let polls = 0;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ route: req.url, body: JSON.parse(body || "{}"), authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url === "/bridge/pairings") res.end(JSON.stringify({ pairing_id: "pair-1", user_code: "ABCD-1234", device_code: "private-poll-secret", verification_uri_complete: "https://talk.shapes.inc/connect-computer?code=ABCD-1234", expires_in: 600 }));
    else res.end(JSON.stringify(++polls === 1 ? { status: "pending" } : { status: "approved", device_id: "device-1", device_token: "persistent-secret" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    let shown;
    const result = await pairDevice({ api: `http://127.0.0.1:${server.address().port}`, name: "Laptop", onCode: (value) => { shown = value.user_code; }, sleep: async () => {} });
    assert.equal(shown, "ABCD-1234");
    assert.equal(result.device_token, "persistent-secret");
    assert.equal(requests[0].body.name, "Laptop");
    assert.equal(requests[1].body.device_code, "private-poll-secret");
    assert.equal(requests[1].authorization, undefined);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("redirects cannot forward the saved device token to another host", async () => {
  const server = http.createServer((_req, res) => { res.writeHead(302, { location: "https://example.com" }); res.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await assert.rejects(apiRequest(`http://127.0.0.1:${server.address().port}`, "/devices/heartbeat", {}, "secret")); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("closing setup aborts an in-flight pairing request and never returns a saved credential", async () => {
  const abort = new AbortController();
  let requested;
  const reached = new Promise((resolve) => { requested = resolve; });
  const server = http.createServer((_req, _res) => { requested(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const pending = pairDevice({ api: `http://127.0.0.1:${server.address().port}`, signal: abort.signal, onCode: () => assert.fail("must not expose a pending code") });
    await reached;
    abort.abort(new Error("Window closed"));
    await assert.rejects(pending, /Window closed/);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
