"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

// The standalone npm distribution carries source, not a downloaded binary.
// Compile with the installed Windows Framework into private, source-versioned
// storage. Updating source never replaces a helper an older job is executing.
// Signed desktop bundles do not use this path: they require their fixed helper.
function ensureWindowsJobHost({ source = path.resolve(__dirname, "../scripts/windows/JobHost.cs"),
  directory = path.join(require("./state").ensureStateDir(), "native-helpers"),
  systemRoot = process.env.SystemRoot || "C:\\Windows", compile = spawnSync } = {}) {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 131072) throw new Error("Invalid Windows process supervisor source.");
  const code = fs.readFileSync(source);
  const digest = crypto.createHash("sha256").update(code).digest("hex");
  const target = path.join(directory, digest), output = path.join(target, "shapes.inc Bridge Job.exe");
  const ready = () => {
    try { const value = fs.lstatSync(output); return value.isFile() && !value.isSymbolicLink() && value.size > 0; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  };
  if (ready()) return output;
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const work = fs.mkdtempSync(path.join(target, "build-"));
  try {
    const input = path.join(work, "JobHost.cs"), executable = path.join(work, "Job.exe");
    fs.writeFileSync(input, code, { flag: "wx", mode: 0o600 });
    const compiler = path.win32.join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    const result = compile(compiler, ["/nologo", "/optimize+", "/platform:x64", "/target:exe", `/out:${executable}`, input],
      { encoding: "utf8", windowsHide: true, shell: false, timeout: 20000, maxBuffer: 65536 });
    if (result.error || result.status !== 0 || !fs.existsSync(executable)) throw new Error("The Windows process supervisor could not be built. Install the Windows .NET Framework and retry.");
    try { fs.renameSync(executable, output); }
    catch (error) { if (!["EEXIST", "EPERM", "EACCES"].includes(error.code) || !ready()) throw error; }
    if (!ready()) throw new Error("The Windows process supervisor is unavailable.");
    return output;
  } finally { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

module.exports = { ensureWindowsJobHost };
