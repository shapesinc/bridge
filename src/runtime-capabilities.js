"use strict";

const { bundledRuntime } = require("./bundled-runtime");
const { supportsToolProxy } = require("./native-tool-proxy");

// Discovery reports implementation availability, not permission or activation.
// The backend still owns each task's current feature flag and scoped grant.
function runtimeCapabilities({ platform = process.platform, available = bundledRuntime().available } = {}) {
  return { bundled_sessions: available, session_input: available, native_tool_proxy: available && supportsToolProxy(platform) };
}

module.exports = { runtimeCapabilities };
