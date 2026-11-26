"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ensureStateDir, isPrivateWindowsAcl, windowsDirectoryAcl } = require("../src/state");

const SID = "S-1-5-21-1004336348-1177238915-682003330-1001";
const PRIVATE = `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${SID})`;

// Only an exactly private directory skips the rewrite; anything that grants
// more, or that we cannot read, is secured again.
test("only the exact private Windows ACL counts as already secured", () => {
  assert.equal(isPrivateWindowsAcl(PRIVATE, SID), true);
  assert.equal(isPrivateWindowsAcl(`D:PAI(A;CIOI;0x1f01ff;;;${SID.toLowerCase()})(A;OICI;FA;;;S-1-5-18)`, SID), true);
  for (const sddl of [
    `D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;${SID})`, // inheritance still on
    `${PRIVATE}(A;OICI;FA;;;BA)`, // administrators too
    `${PRIVATE}(A;OICIID;FA;;;WD)`, // an inherited entry for everyone
    `D:PAI(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;${SID})`, // read-only for the owner
    `D:PAI(A;OI;FA;;;SY)(A;OICI;FA;;;${SID})`, // not inherited by folders
    `D:PAI(D;OICI;FA;;;SY)(A;OICI;FA;;;${SID})`, // a deny entry
    `D:PAI(A;OICI;FA;;;${SID})`, // SYSTEM missing
    `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-1-2-3-500)`, // another account
    "", null,
  ]) assert.equal(isPrivateWindowsAcl(sddl, SID), false, String(sddl));
  assert.equal(isPrivateWindowsAcl(PRIVATE, "S-1-5-18"), false);
  // The built-in Administrator is written by alias, only for that account.
  const administrator = "S-1-5-21-1004336348-1177238915-682003330-500";
  assert.equal(isPrivateWindowsAcl("D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)", administrator), true);
  assert.equal(isPrivateWindowsAcl("D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)", SID), false);
  assert.equal(isPrivateWindowsAcl("D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)(A;OICI;FA;;;BA)", administrator), false);
  const entra = "S-1-12-1-3570083064-1146225218-1418543779-2847911425";
  assert.equal(isPrivateWindowsAcl(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${entra})`, entra), true);
});

test("a secured Windows state directory reads back as private, so later processes leave it alone", { skip: process.platform !== "win32" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-acl-")), previous = process.env.SHAPES_BRIDGE_HOME;
  process.env.SHAPES_BRIDGE_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sid = /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).stdout)[1];
  assert.equal(isPrivateWindowsAcl(windowsDirectoryAcl(dir), sid), false, "a fresh temp directory inherits a shared ACL");
  ensureStateDir();
  // Securing removes inherited entries and sets this account and SYSTEM. It
  // never removes other explicit entries, and a runner's temp folder carries
  // one for Administrators.
  // A store under a profile folder has only inherited entries before it is
  // secured; model that by removing the runner's extra explicit entry.
  assert.equal(spawnSync("icacls.exe", [dir, "/remove:g", "*S-1-5-32-544"], { encoding: "utf8" }).status, 0);
  const sddl = windowsDirectoryAcl(dir);
  assert.equal(isPrivateWindowsAcl(sddl, sid), true, sddl);
});
