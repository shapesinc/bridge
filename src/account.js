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

async function apiRequest(api, route, body, token, method = "POST", timeoutMs = 20000, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Connection request timed out.")), timeoutMs);
  try {
  const response = await fetch(`${validateApi(api)}/bridge${route}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: controller.signal,
    redirect: "error",
  });
  if (!response.ok) {
    const error = new Error(`shapes.inc connection request failed (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return await response.json();
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function pairDevice({ api = DEFAULT_API, name = os.hostname(), onCode, signal, sleep = abortableDelay }) {
  signal?.throwIfAborted();
  const pairing = await apiRequest(api, "/pairings", { name, platform: process.platform }, undefined, "POST", 20000, signal);
  const verification = new URL(pairing.verification_uri_complete);
  if (verification.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(verification.hostname)) {
    throw new Error("shapes.inc returned an insecure approval URL.");
  }
  await onCode(pairing);
  const deadline = Date.now() + Math.min(pairing.expires_in || 600, 600) * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.max(3, pairing.interval || 3) * 1000, signal);
    signal?.throwIfAborted();
    const result = await apiRequest(api, "/pairings/poll", { pairing_id: pairing.pairing_id, device_code: pairing.device_code }, undefined, "POST", 20000, signal);
    if (result.status === "approved" && result.device_id && result.device_token) {
      return { api: validateApi(api), device_id: result.device_id, device_token: result.device_token, name };
    }
    if (result.status && result.status !== "pending") throw new Error("Computer approval expired or was declined. Run setup again.");
  }
  throw new Error("Computer approval expired. Run setup again when you are ready.");
}

module.exports = { DEFAULT_API, validateApi, apiRequest, pairDevice };
