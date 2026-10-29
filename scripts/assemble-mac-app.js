#!/usr/bin/env node
"use strict";
// Assemble an unsigned shapes.inc Bridge.app from this checkout and a Node
// binary (normally the universal one built by scripts/build-mac-release.sh).
//   node scripts/assemble-mac-app.js --node <node binary> --out <path/to/shapes.inc Bridge.app>
const path = require("node:path");
const { assembleMacApp } = require("../src/service");
const argv = process.argv.slice(2);
const option = (name) => { const index = argv.indexOf(name); if (index === -1 || !argv[index + 1]) throw new Error(`${name} is required`); return argv[index + 1]; };
const optional = (name) => argv.includes(name) ? path.resolve(option(name)) : undefined;
const result = assembleMacApp(path.resolve(__dirname, ".."), path.resolve(option("--out")), {
  nodeBinary: path.resolve(option("--node")), launcherBinary: optional("--launcher"),
  controlsBinary: optional("--controls"), cloudflaredBinary: optional("--cloudflared"),
});
process.stdout.write(`${result.app}\n`);
