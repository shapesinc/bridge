"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { ensureWindowsJobHost } = require("../src/windows-job");

test("standalone helper compilation is local, bounded, source-versioned and reused", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-job-cache-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.cs"); fs.writeFileSync(source, "first source");
  const previousCache = path.join(directory, crypto.createHash("sha256").update("first source").digest("hex"));
  fs.mkdirSync(previousCache); fs.writeFileSync(path.join(previousCache, "shapes.inc Bridge Job.exe"), "old console executable");
  const calls = [];
  const compile = (file, args, options) => {
    calls.push({ file, args, options });
    fs.writeFileSync(args.find((arg) => arg.startsWith("/out:")).slice(5), "owned fixture binary"); return { status: 0 };
  };
  const options = { directory, source, compile, systemRoot: "C:\\Windows" };
  const first = ensureWindowsJobHost(options);
  assert.notEqual(path.dirname(first), previousCache, "source-only console cache must not satisfy the GUI build contract");
  assert.equal(fs.readFileSync(path.join(previousCache, "shapes.inc Bridge Job.exe"), "utf8"), "old console executable");
  assert.equal(ensureWindowsJobHost(options), first); assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe");
  assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.timeout, 20000);
  assert.ok(calls[0].args.includes("/target:winexe"));
  fs.writeFileSync(source, "second source");
  const second = ensureWindowsJobHost(options); assert.notEqual(second, first);
  assert.equal(fs.existsSync(first), true); assert.equal(calls.length, 2);
});

test("failed standalone compilation never leaves a launchable cache entry", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-job-failure-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.cs"); fs.writeFileSync(source, "source");
  assert.throws(() => ensureWindowsJobHost({ directory, source, compile: () => ({ status: 1, stderr: "private diagnostic" }) }), /could not be built/);
  const cached = fs.readdirSync(directory).filter((name) => name !== "source.cs");
  assert.equal(cached.length, 1); assert.deepEqual(fs.readdirSync(path.join(directory, cached[0])), []);
});
