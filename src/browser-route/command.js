"use strict";

// `shapes-bridge route-browser on|off` and its status line. The service, prompt and API are injected
// so the consent and kill-switch rules are tested without touching the real background service.
const { ROUTE } = require("./index");

const CONSENT = "Let your agent's browser use this computer's internet connection? Sites it opens for you will see your home internet and location, as if you were browsing. Only for your own messages in shapes.inc. Turn it off any time: shapes-bridge route-browser off.";
const REMOVED = "This computer was removed from shapes.inc. Run install to reconnect.";
const NOT_AVAILABLE = "Agent browsing through this computer isn't available for your shapes.inc account yet.";

/** shapes.inc's own explanation, as plain one-line text (no terminal control characters). */
function serverText(body) {
  const text = typeof body?.error === "string" ? body.error : "";
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 300);
}

/**
 * Runs `route-browser on|off`. Dependencies: config (saved), request (account.apiRequest),
 * writeConfig(next), restart() (restart the background service), ask(question) -> answer, log(line).
 */
async function routeBrowserCommand({ action, yes = false, config, request, writeConfig, restart, ask, log }) {
  if (action === "on") {
    if (config.revoked) throw new Error(REMOVED);
    log(CONSENT);
    const answer = yes ? "y" : String(await ask("Turn it on? (y/N) ") || "");
    if (!/^y(es)?$/i.test(answer.trim())) {
      log(`Nothing changed. Agent browsing through this computer is ${config.route_browser === true ? "still on" : "off"}.`);
      return false;
    }
    let result;
    try {
      result = await request(config.api, ROUTE, { enabled: true }, config.device_token);
    } catch (error) {
      if (error.status === 401) throw new Error(REMOVED);
      if (error.status === 403) throw new Error(serverText(error.body) || NOT_AVAILABLE);
      throw new Error("Could not reach shapes.inc, so nothing changed. Try again when you're online.");
    }
    if (result?.enabled !== true) throw new Error(serverText(result) || NOT_AVAILABLE);
    writeConfig({ ...config, route_browser: true });
    if (config.paused) {
      log("On. It starts when you resume this computer's connection. Turn it off any time: shapes-bridge route-browser off.");
    } else {
      restart();
      log("On. Your agent's browser can use this computer's internet connection for your own messages in shapes.inc. Turn it off any time: shapes-bridge route-browser off.");
    }
    return true;
  }
  if (action === "off") {
    // The kill switch works offline: the local stop comes first and never waits on shapes.inc.
    writeConfig({ ...config, route_browser: false });
    if (!config.paused && !config.revoked) restart();
    if (!config.revoked) {
      try { await request(config.api, ROUTE, { enabled: false }, config.device_token, "POST", 5000); }
      catch { log("Stopped on this computer. shapes.inc will see it as off once it reconnects."); }
    }
    log("Off. Nothing your agent's browser opens goes through this computer now.");
    return false;
  }
  throw new Error("Use route-browser on or route-browser off.");
}

/** The `status` line: on/off, and what it's doing when on. `status` is a recent status.json, or null. */
function routeStatusLine(config, status) {
  if (config.route_browser !== true) return "Agent browsing through this computer: off";
  const state = status?.browser_route;
  if (state === "on") {
    const megabytes = (status.browser_route_bytes_today || 0) / 1048576;
    return `Agent browsing through this computer: on, ${status.browser_route_open || 0} open now` +
      (megabytes >= 0.1 ? `, ${megabytes.toFixed(1)} MB today` : "");
  }
  if (state === "not_available") return "Agent browsing through this computer: on, but not available for your shapes.inc account yet";
  if (state === "offline") return "Agent browsing through this computer: on, connecting";
  return "Agent browsing through this computer: on";
}

module.exports = { CONSENT, routeBrowserCommand, routeStatusLine };
