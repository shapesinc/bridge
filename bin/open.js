"use strict";

// Loaded through NODE_OPTIONS from the macOS app bundle's Info.plist. When the
// person opens "shapes.inc Bridge" from Finder or Spotlight, Node starts with no
// script, so this hook restarts the connection and exits. Launches that carry a
// script (the launchd daemon, the local launcher) are left untouched.
if (process.argv.length <= 1) {
  const { openApp, notify } = require("../src/open");
  openApp().then(() => process.exit(0), (error) => {
    notify(`shapes.inc Bridge could not restart: ${error.message}`);
    process.exit(1);
  });
}
