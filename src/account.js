"use strict";

const os = require("node:os");

const DEFAULT_API = "https://api.shapes.inc";

function validateApi(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("The shapes.inc API must use HTTPS (HTTP is allowed only on localhost for development).");
  }
  return url.href.replace(/\/$/, "");
}

async function apiRequest(api, route, body, token, method = "POST", timeoutMs = 20000) {
  const response = await fetch(`${validateApi(api)}/bridge${route}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok) {
    const error = new Error(`shapes.inc connection request failed (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function pairDevice({ api = DEFAULT_API, name = os.hostname(), onCode, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const pairing = await apiRequest(api, "/pairings", { name, platform: process.platform });
  const verification = new URL(pairing.verification_uri_complete);
  if (verification.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(verification.hostname)) {
    throw new Error("shapes.inc returned an insecure approval URL.");
  }
  await onCode(pairing);
  const deadline = Date.now() + Math.min(pairing.expires_in || 600, 600) * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.max(3, pairing.interval || 3) * 1000);
    const result = await apiRequest(api, "/pairings/poll", { pairing_id: pairing.pairing_id, device_code: pairing.device_code });
    if (result.status === "approved" && result.device_id && result.device_token) {
      return { api: validateApi(api), device_id: result.device_id, device_token: result.device_token, name };
    }
    if (result.status && result.status !== "pending") throw new Error("Computer approval expired or was declined. Run setup again.");
  }
  throw new Error("Computer approval expired. Run setup again when you are ready.");
}

module.exports = { DEFAULT_API, validateApi, apiRequest, pairDevice };
