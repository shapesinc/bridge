"use strict";

// Convert native, pending requests into a small display contract. Responses are
// reconstructed from the original request, never forwarded as arbitrary RPC.
const crypto = require("node:crypto");
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const reserved = new Set(["__proto__", "prototype", "constructor"]);

function text(value, limit = 4000) {
  if (typeof value !== "string" || value.length > limit) throw new Error("Unsupported approval text.");
  return value;
}

function key(value) {
  if (!text(value, 128) || reserved.has(value)) throw new Error("Unsupported approval field.");
  return value;
}

function options(schema) {
  const entries = schema.oneOf || schema.anyOf;
  let result;
  if (entries) {
    if (!Array.isArray(entries)) throw new Error("Unsupported approval options.");
    result = entries.map((entry) => ({ value: text(entry.const, 500), label: text(entry.title, 500) }));
  } else if (Array.isArray(schema.enum)) {
    result = schema.enum.map((value, index) => ({ value: text(value, 500), label: text(schema.enumNames?.[index] || value, 500) }));
  }
  if (result && (!result.length || result.length > 30 || new Set(result.map((entry) => entry.value)).size !== result.length)) {
    throw new Error("Unsupported approval options.");
  }
  return result;
}

function formFields(schema) {
  if (!object(schema) || schema.type !== "object" || !object(schema.properties)
      || Object.keys(schema).some((name) => !["$schema", "type", "properties", "required", "additionalProperties"].includes(name))
      || (schema.additionalProperties !== undefined && schema.additionalProperties !== false)) throw new Error("Unsupported approval form.");
  const required = schema.required || [];
  if (!Array.isArray(required) || required.some((name) => !own(schema.properties, name))) throw new Error("Unsupported required fields.");
  const fields = Object.entries(schema.properties).map(([id, property]) => {
    key(id);
    if (!object(property)) throw new Error("Unsupported approval field.");
    const allowed = ["type", "title", "description", "default", "enum", "enumNames", "oneOf", "items", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "format"];
    if (Object.keys(property).some((name) => !allowed.includes(name))) throw new Error("Unsupported approval constraint.");
    const field = { id, label: text([property.title, property.description].filter(Boolean).join(" — ") || id, 1000), required: required.includes(id) };
    for (const [native, wire] of Object.entries({ minimum: "minimum", maximum: "maximum", minLength: "min_length", maxLength: "max_length", minItems: "min_items", maxItems: "max_items" })) {
      if (property[native] == null) continue;
      const value = property[native];
      if (typeof value !== "number" || !Number.isFinite(value)
          || (!["minimum", "maximum"].includes(native) && (!Number.isSafeInteger(value) || value < 0))) throw new Error("Invalid approval constraint.");
      field[wire] = value;
    }
    if ((field.min_length || 0) > 4000 || (field.min_items || 0) > 30) throw new Error("Approval answer exceeds supported limits.");
    if (property.format != null) {
      if (!["email", "uri", "date", "date-time"].includes(property.format)) throw new Error("Unsupported approval format.");
      field.format = property.format;
    }
    if (property.type === "string") {
      const choices = options(property);
      field.max_length = Math.min(field.max_length ?? 4000, 4000);
      return { ...field, type: choices ? "select" : "text", ...(choices ? { options: choices } : {}) };
    }
    if (["number", "integer"].includes(property.type)) return { ...field, type: "number", integer: property.type === "integer" };
    if (property.type === "boolean") return { ...field, type: "boolean" };
    if (property.type === "array" && object(property.items)) {
      const choices = options(property.items);
      if (choices) return { ...field, type: "multiselect", options: choices };
    }
    throw new Error("Unsupported approval field type.");
  });
  if (fields.length > 12) throw new Error("Too many approval fields.");
  return fields;
}

function normalizeRequest(request) {
  const p = request.params;
  if (!object(p)) throw new Error("Invalid native request.");
  let title, message, fields = [], kind = "permission", choices;
  if (request.method === "mcpServer/elicitation/request") {
    // URL authentication and device-verification proofs must use their native
    // trusted surfaces. A chat checkbox cannot substitute for either.
    if (!["form", "openai/form", "openaiForm"].includes(p.mode)) throw new Error("This native approval needs the local app.");
    title = "Computer permission";
    message = text(p.message);
    // Native action-level approvals can put the recipient, order or other
    // consequential arguments in metadata. Show that reviewed subset intact;
    // never turn a detailed action approval into a generic site-access button.
    if (object(p._meta)) {
      const details = [];
      if (p._meta.tool_title != null) details.push(text(p._meta.tool_title, 500));
      if (p._meta.tool_description != null) details.push(text(p._meta.tool_description, 2000));
      if (own(p._meta, "tool_params")) details.push(text(JSON.stringify(p._meta.tool_params, null, 2), 4000));
      if (details.length) message = text([message, ...details].join("\n\n"));
    }
    fields = formFields(p.requestedSchema);
    if (fields.length) { kind = "input"; title = "Computer task needs your input"; }
  } else if (request.method === "item/tool/requestUserInput") {
    if (!Array.isArray(p.questions) || !p.questions.length || p.questions.length > 12) throw new Error("Unsupported questions.");
    title = "Computer task needs your input";
    message = "";
    kind = "input";
    fields = p.questions.map((question) => {
      if (question.isSecret) throw new Error("Enter secrets in the native app.");
      const choices = question.options?.length ? question.options.map((option) => ({
        value: text(option.label, 500), label: text(option.description ? `${option.label} — ${option.description}` : option.label, 1000),
      })) : undefined;
      if (choices && choices.length > 30) throw new Error("Too many options.");
      return { id: key(question.id), label: text(question.question, 1000), required: true, max_length: 4000,
        type: choices ? "select" : "text", ...(choices ? { options: choices, allow_custom: question.isOther === true } : {}) };
    });
  } else if (request.method === "item/commandExecution/requestApproval") {
    title = "Allow this command?";
    if (!p.command) throw new Error("Missing command to review.");
    message = text([p.reason, p.cwd && `Directory: ${p.cwd}`, p.command].filter(Boolean).join("\n\n"));
    if (p.availableDecisions != null) {
      if (!Array.isArray(p.availableDecisions)) throw new Error("Invalid command decisions.");
      choices = ["accept", "decline", "cancel"].filter((decision) => p.availableDecisions.includes(decision));
      if (!choices.length) throw new Error("No supported one-time decision.");
    }
  } else {
    throw new Error("Unsupported native approval request.");
  }
  if (new Set(fields.map((field) => field.id)).size !== fields.length) throw new Error("Duplicate approval field.");
  const result = { id: crypto.randomUUID(), kind, title, message, fields,
    choices: (choices || (kind === "input" ? ["accept", "cancel"] : ["accept", "decline", "cancel"])).map((id) => ({ id,
      label: id === "accept" ? (kind === "input" ? "Continue" : request.method === "item/commandExecution/requestApproval" ? "Allow once" : "Allow") : id === "decline" ? "Deny" : "Cancel task" })) };
  if (Buffer.byteLength(JSON.stringify(result)) > 16000) throw new Error("Approval request is too large.");
  return result;
}

function validateValue(field, property, value) {
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new Error("Choose yes or no.");
  } else if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)
        || (property?.type === "integer" && !Number.isInteger(value))
        || (property?.minimum != null && value < property.minimum)
        || (property?.maximum != null && value > property.maximum)) throw new Error("Enter a valid number.");
  } else if (field.type === "multiselect") {
    if (!Array.isArray(value) || value.length > 30 || new Set(value).size !== value.length
        || value.some((entry) => !field.options.some((option) => option.value === entry))
        || (property?.minItems != null && value.length < property.minItems)
        || (property?.maxItems != null && value.length > property.maxItems)) throw new Error("Choose valid options.");
  } else {
    text(value, 4000);
    if ((field.required && !value.trim())
        || (property?.minLength != null && [...value].length < property.minLength)
        || (property?.maxLength != null && [...value].length > property.maxLength)
        || (field.options && !field.allow_custom && !field.options.some((option) => option.value === value))) throw new Error("Enter a valid answer.");
    if (property?.format) {
      const valid = property.format === "email" ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
        : property.format === "uri" ? (() => { try { return Boolean(new URL(value).protocol); } catch { return false; } })()
          : property.format === "date" ? /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
            : property.format === "date-time" ? /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)) : false;
      if (!valid) throw new Error("Enter a valid formatted answer.");
    }
  }
}

function nativeResponse(request, display, response) {
  if (!object(response) || Object.keys(response).some((name) => !["decision", "values"].includes(name))
      || !display.choices.some((choice) => choice.id === response.decision)) throw new Error("Invalid approval response.");
  const values = response.values || {};
  if (!object(values) || Object.keys(values).some((name) => !display.fields.some((field) => field.id === name))) throw new Error("Unknown answer field.");
  if (response.decision === "accept") {
    for (const field of display.fields) {
      if (!own(values, field.id)) {
        if (field.required) throw new Error("Answer every required question.");
        continue;
      }
      validateValue(field, request.params.requestedSchema?.properties[field.id], values[field.id]);
    }
  } else if (Object.keys(values).length) throw new Error("Declining does not submit answers.");
  if (request.method === "mcpServer/elicitation/request") return {
    action: response.decision, content: response.decision === "accept" ? values : null,
  };
  if (request.method === "item/tool/requestUserInput") return {
    answers: response.decision === "accept" ? Object.fromEntries(display.fields.map((field) => [field.id, { answers: [values[field.id]] }])) : {},
  };
  return { decision: response.decision };
}

module.exports = { normalizeRequest, nativeResponse };
