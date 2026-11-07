"use strict";

const crypto = require("node:crypto");

const MAX_INPUT_BYTES = 128 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024;
const MAX_IMAGES = 4;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);

// The authenticated backend materializes attachments from the original message.
// This transport does not fetch URLs or grant access to local files. The pinned
// app-server accepts inline images, but rejects remote image URLs.
function normalizeSessionInput(value) {
  if (!Array.isArray(value) || !value.length || value.length > 64) throw new Error("Session input must contain 1–64 text or image items.");
  let images = 0, imageBytes = 0, textBytes = 0, meaningful = false;
  const contextKeys = new Set();
  const input = value.map((item) => {
    if (!object(item)) throw new Error("Session input items must be text or image objects.");
    const context = {};
    if (Object.hasOwn(item, "context_key")) {
      if (typeof item.context_key !== "string" || !/^[A-Za-z0-9_:-]{1,160}$/.test(item.context_key)
          || contextKeys.has(item.context_key)) throw new Error("Input context keys must be unique bounded identifiers.");
      contextKeys.add(item.context_key);
      context.context_key = item.context_key;
    }
    if (item.type === "text" && Object.keys(item).every((key) => ["type", "text", "context_key"].includes(key)) && typeof item.text === "string") {
      textBytes += Buffer.byteLength(item.text);
      if (textBytes > MAX_TEXT_BYTES) throw new Error("Session input text must be no larger than 64 KiB.");
      meaningful ||= Boolean(item.text.trim());
      return { type: "text", text: item.text, ...context };
    }
    if (item.type === "image" && Object.keys(item).every((key) => ["type", "url", "context_key"].includes(key)) && typeof item.url === "string") {
      if (++images > MAX_IMAGES) throw new Error("Session input supports at most 4 images.");
      if (item.url.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32) throw new Error("Session images must total no more than 64 KiB.");
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.url);
      if (!match) throw new Error("Session images require inline PNG, JPEG or WebP data URLs.");
      const bytes = Buffer.from(match[2], "base64");
      const signature = match[1] === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : match[1] === "jpeg" ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
      if (!signature || bytes.toString("base64") !== match[2]) throw new Error("Session image encoding does not match its MIME type.");
      imageBytes += bytes.length;
      if (imageBytes > MAX_IMAGE_BYTES) throw new Error("Session images must total no more than 64 KiB.");
      meaningful = true;
      return { type: "image", url: item.url, ...context };
    }
    throw new Error("Session input supports only text and inline image data URLs.");
  });
  if (!meaningful) throw new Error("Session input must not be empty.");
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) throw new Error("Session input must be no larger than 128 KiB.");
  return input;
}

function runtimeSessionInput(input, delivered = {}) {
  const bindings = {}, runtimeInput = [];
  for (const item of input) {
    const { context_key: key, ...content } = item;
    if (key) {
      const digest = crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
      if (Object.hasOwn(delivered, key)) {
        if (delivered[key] !== digest) throw Object.assign(new Error("This input context key already identifies different content."), { statusCode: 409 });
        continue;
      }
      Object.defineProperty(bindings, key, { value: digest, enumerable: true });
    }
    runtimeInput.push(content);
  }
  if (!runtimeInput.length) throw new Error("This context is already delivered. Include a new instruction for the next turn.");
  return { runtimeInput, inputContext: bindings };
}

function sessionInputText(input) {
  const text = input.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  // This legacy field is only a job preview when structured input is present.
  // Keep its separators from making an otherwise valid 64 KiB packet fail the
  // legacy prompt limit. The complete input remains persisted and dispatched.
  return text.trim() ? text.trim().replace(/\s+/g, " ").slice(0, 160) : "Image attachment";
}

module.exports = { normalizeSessionInput, sessionInputText, runtimeSessionInput, MAX_INPUT_BYTES, MAX_TEXT_BYTES, MAX_IMAGE_BYTES, MAX_IMAGES };
