#!/usr/bin/env node
"use strict";
const readline = require("node:readline");
const { createDesktopController } = require("../src/desktop");
const publish = (status) => process.stdout.write(JSON.stringify({ status }) + "\n");
const controller = createDesktopController({ publish });
const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  // One fixed command per bounded line; no paths, shell, arbitrary methods or
  // pairing credentials can be supplied by the host application.
  if (line.length > 128) return;
  const operations = { status: controller.status, connect: controller.connect,
    pause: controller.pause, permissions: controller.permissions };
  if (!Object.hasOwn(operations, line)) return;
  const operation = operations[line];
  Promise.resolve().then(operation).then(publish).catch((error) => publish({ ...controller.status(), error: error.message }));
});
lines.on("close", () => controller.dispose());
process.on("SIGTERM", () => { controller.dispose(); lines.close(); });
publish(controller.status());
