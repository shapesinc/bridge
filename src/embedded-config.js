"use strict";

const { DEFAULT_API } = require("./account");

// Private signed-host configuration, never an RPC argument. Match the literal
// origin before URL normalization can turn alternate IP spellings into loopback.
function embeddedApiOrigin(value) {
  if (value === undefined || value === DEFAULT_API) return DEFAULT_API;
  const match = typeof value === "string" &&
    /^http:\/\/(127\.0\.0\.1):([1-9][0-9]{0,4})$/.exec(value);
  if (!match || Number(match[2]) > 65535) throw new Error("Invalid embedded API origin.");
  return `http://${match[1]}:${match[2]}`;
}

module.exports = { embeddedApiOrigin };
