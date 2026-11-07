"use strict";

const crypto = require("node:crypto");
const { readState, writeState } = require("./state");
const RECEIPT = "embedded-account-clear", ACK = "embedded-account-clear-consumed", MAX_BYTES = 256;
const validToken = (value) => value === "none" || typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function validate(value) {
  if (!value || Object.keys(value).length !== 2 || value.version !== 1 || !validToken(value.revocationToken) || value.revocationToken === "none") {
    throw new Error("Invalid account revocation receipt");
  }
  return value.revocationToken;
}

// The writer records intent only. Only a live controller can acknowledge that
// authority was cleared, startup disabled and its owned runtime stopped.
function createAccountRevocation({ read = readState, write = writeState } = {}) {
  let seen = "none";
  function snapshot() {
    const receipt = read(RECEIPT, { maxBytes: MAX_BYTES }), consumed = read(ACK, { maxBytes: MAX_BYTES });
    const acknowledged = consumed === null ? "none" : validate(consumed);
    const revocationToken = receipt === null ? "none" : validate(receipt);
    if (revocationToken === "none" && (acknowledged !== "none" || seen !== "none")) throw new Error("Account revocation history is missing");
    seen = revocationToken;
    return { version: 1, revocationToken, pending: revocationToken !== acknowledged };
  }
  function record() {
    // Recording a fresh valid intent is the bounded recovery path for damaged
    // receipt bytes. Acknowledgement remains untouched and cannot imply cleanup.
    const receipt = { version: 1, revocationToken: crypto.randomUUID() };
    write(RECEIPT, receipt, { durable: true });
    seen = receipt.revocationToken;
    return receipt;
  }
  async function consume(apply) {
    const receipt = snapshot();
    if (!receipt.pending) return receipt;
    await apply(receipt.revocationToken);
    // A new clear during cleanup must remain pending. Never delete receipts or
    // acknowledge a token that was not the exact cleanup input.
    if (snapshot().revocationToken !== receipt.revocationToken) return snapshot();
    write(ACK, { version: 1, revocationToken: receipt.revocationToken }, { durable: true });
    return snapshot();
  }
  return { read: snapshot, record, consume };
}

module.exports = { createAccountRevocation, validToken, MAX_BYTES, RECEIPT, ACK };
