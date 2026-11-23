"use strict";

// Images from the person's own chat message, handed to their Claude Code or
// Codex with the task: the screenshot or wireframe they attached is part of
// what they asked. The authenticated backend reads the persisted message and
// sends the bytes; this computer fetches nothing and reads no other file.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_IMAGES = 4;
// Claude's API takes images up to 5 MB; the backend downsizes larger ones.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TYPES = {
  "image/png": { ext: "png", sniff: (bytes) => bytes.subarray(0, 8).equals(PNG) },
  "image/jpeg": { ext: "jpg", sniff: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  "image/webp": { ext: "webp", sniff: (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP" },
  "image/gif": { ext: "gif", sniff: (bytes) => /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1")) },
};

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// [{media_type, data (base64), name?}] -> [{media_type, bytes, name}]
function normalizeImages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES) throw invalid(`images must be a list of at most ${MAX_IMAGES} images.`);
  let total = 0;
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || Object.keys(item).some((key) => !["media_type", "data", "name"].includes(key))
        || !Object.hasOwn(TYPES, item.media_type) || typeof item.data !== "string"
        || (item.name !== undefined && (typeof item.name !== "string" || item.name.length > 200))) {
      throw invalid("Each image needs a PNG, JPEG, WebP or GIF media_type, base64 data and an optional short name.");
    }
    if (item.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) {
      throw invalid("Each image must be base64 data of at most 5 MB.");
    }
    const bytes = Buffer.from(item.data, "base64");
    if (!bytes.length || bytes.toString("base64") !== item.data || !TYPES[item.media_type].sniff(bytes)) {
      throw invalid("An image's data does not match its media_type.");
    }
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw invalid("Images must total at most 12 MB.");
    return { media_type: item.media_type, bytes, name: item.name?.replace(/[\r\n]/g, " ").trim() || undefined };
  });
}

// Part of a start's request fingerprint: the same retry carries the same images.
function imagesDigest(images) {
  return images.map((image) => `${image.media_type}:${crypto.createHash("sha256").update(image.bytes).digest("hex")}`);
}

// Private copies in the job folder, so the agent can also open or copy them.
function saveImages(directory, images, writePrivate) {
  if (!images.length) return [];
  const folder = path.join(directory, "images");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  return images.map((image, index) => {
    const file = path.join(folder, `${index + 1}.${TYPES[image.media_type].ext}`);
    writePrivate(file, image.bytes);
    return { media_type: image.media_type, path: file, ...(image.name ? { name: image.name } : {}) };
  });
}

function imageNote(saved) {
  if (!saved?.length) return "";
  const lines = saved.map((image, index) => `- ${image.name || `image ${index + 1}`}: ${image.path}`);
  return `\n\n(The person attached ${saved.length === 1 ? "this image" : "these images"} to their message; a copy is also saved at:\n${lines.join("\n")})`;
}

// Claude Code's stream-json user message: the prompt, then each image.
function claudeUserMessage(prompt, saved) {
  if (!saved?.length) return { type: "user", message: { role: "user", content: prompt } };
  return { type: "user", message: { role: "user", content: [
    { type: "text", text: prompt + imageNote(saved) },
    ...saved.map((image) => ({ type: "image", source: { type: "base64", media_type: image.media_type,
      data: fs.readFileSync(image.path).toString("base64") } })),
  ] } };
}

// Codex app-server input (codex-rpc start): the prompt, then each image by path.
function codexInput(prompt, saved) {
  return { text: prompt + imageNote(saved), localImages: (saved || []).map((image) => image.path) };
}

module.exports = { normalizeImages, imagesDigest, saveImages, claudeUserMessage, codexInput, imageNote, MAX_IMAGES };
