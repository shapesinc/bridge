"use strict";

// What this computer will connect to for the agent: public internet addresses on the web's
// ports, never its own network (router, NAS, printer, localhost services) or anything reserved.
// The check runs on the addresses this computer itself resolved, right before it connects to them,
// so a hostname that resolves to 192.168.1.1 (DNS rebinding) is refused like the literal is.
// A port of the relay's addresses.mjs (app repo, workers/device-relay/src/addresses.mjs).
const { BlockList, isIP } = require("node:net");

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  // No ::ffff:0:0/96 here: BlockList checks IPv4 addresses against IPv6 rules as mapped ones, so it would
  // block every IPv4 address. Mapped addresses are unwrapped in isPublicAddress instead.
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blocked.addSubnet(network, prefix, "ipv6");

const WEB_PORTS = new Set([80, 443]);

/** A public unicast address: true; anything private, local, reserved or not an IP: false. */
function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]);
    // Global unicast is 2000::/3; everything else in IPv6 is special-purpose.
    return /^[23]/.test(address) && !blocked.check(address, "ipv6");
  }
  return false;
}

/** A hostname or IP literal fit to open (length and characters), lowercased; else undefined. */
function targetHost(host) {
  if (typeof host !== "string") return undefined;
  const bare = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (isIP(bare)) return bare;
  return bare.length <= 253 && /^(?=.*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/.test(bare) ? bare.replace(/\.$/, "") : undefined;
}

module.exports = { WEB_PORTS, isPublicAddress, targetHost };
