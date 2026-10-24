"use strict";

// Explicit semantics only: question wording and field ids are never guesses.
const fields = {
  personal: ["first_name", "last_name", "date_of_birth", "gender", "nationality"],
  contact: ["email", "phone", "title"],
  address: ["name", "line1", "line2", "city", "state", "postal_code", "country"],
  travel: ["passport_number", "passport_expiry", "passport_country"],
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function reference(value) {
  if (!object(value) || Object.keys(value).length !== 2
      || typeof value.section !== "string" || typeof value.field !== "string"
      || !Object.hasOwn(fields, value.section) || !fields[value.section].includes(value.field)) return undefined;
  return { section: value.section, field: value.field };
}

function projectAutofill(params, displayFields, method) {
  const meta = object(params._meta?.["shapes.inc/autofill"]) ? params._meta["shapes.inc/autofill"] : {};
  const subject = params.subject === undefined ? meta.subject : params.subject;
  if (!["self", "other"].includes(subject)) return undefined;
  if (subject === "self") {
    for (const field of displayFields) {
      if (!["text", "select"].includes(field.type)) continue;
      const question = method === "item/tool/requestUserInput" ? params.questions?.find((item) => item.id === field.id) : null;
      const source = question?.autofill === undefined ? meta.fields?.[field.id] : question.autofill;
      const semantic = reference(source);
      if (semantic) field.autofill = semantic;
    }
    // Two different boxes must not compete for one saved value (e.g. billing
    // and shipping). Their producer must supply unambiguous semantics.
    const counts = new Map();
    for (const field of displayFields) if (field.autofill) {
      const key = `${field.autofill.section}.${field.autofill.field}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const field of displayFields) if (field.autofill
        && counts.get(`${field.autofill.section}.${field.autofill.field}`) > 1) delete field.autofill;
  }
  return subject;
}

module.exports = { reference, projectAutofill };
