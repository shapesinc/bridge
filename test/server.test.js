"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../src/server");

const TOKEN = "test-token-with-fixed-length";

async function withServer(run) {
  const server = await startServer({ port: 0, token: TOKEN });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function authed(init = {}) {
  return {
    ...init,
    headers: { "content-type": "application/json", "x-token": TOKEN, ...init.headers },
  };
}

test("public health is reachable but machine actions require the token", async () => {
  await withServer(async (base) => {
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
    assert.equal((await fetch(`${base}/sysinfo`)).status, 401);
    assert.equal(
      (await fetch(`${base}/sysinfo`, { headers: { "x-token": "wrong" } })).status,
      401
    );
    assert.equal((await fetch(`${base}/sysinfo`, authed())).status, 200);
  });
});

test("run returns structured output", async () => {
  await withServer(async (base) => {
    const response = await fetch(
      `${base}/run`,
      authed({ method: "POST", body: JSON.stringify({ cmd: "printf bridge-ok" }) })
    );
    const result = await response.json();
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, "bridge-ok");
  });
});

test("write and read round-trip through the token-locked API", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-bridge-test-"));
  const file = path.join(dir, "hello.txt");
  try {
    await withServer(async (base) => {
      const wrote = await fetch(
        `${base}/write`,
        authed({
          method: "POST",
          body: JSON.stringify({ path: file, content: "hello bridge" }),
        })
      );
      assert.equal(wrote.status, 200);
      const read = await (
        await fetch(`${base}/read?path=${encodeURIComponent(file)}`, authed())
      ).json();
      assert.equal(read.content, "hello bridge");
      assert.equal(read.truncated, false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("large reads are bounded before loading the whole file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-bridge-test-"));
  const file = path.join(dir, "large.txt");
  fs.writeFileSync(file, "x".repeat(150000));
  try {
    await withServer(async (base) => {
      const read = await (
        await fetch(`${base}/read?path=${encodeURIComponent(file)}`, authed())
      ).json();
      assert.equal(read.content.length, 100000);
      assert.equal(read.truncated, true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

