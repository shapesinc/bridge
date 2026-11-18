# Account autofill metadata for private input forms

Moved from the README.

Compatible personal-details forms can prefill and save ordinary account details
in shapes.inc after the person submits the form. This never answers a question
or approves a command by itself. Existing unannotated questions are unchanged.
No labels or ids are interpreted as personal information.

An MCP form producer can attach this extension to its native elicitation params
without changing the original `requestedSchema`:

```json
{
  "_meta": {
    "shapes.inc/autofill": {
      "subject": "self",
      "fields": {
        "delivery_email": { "section": "contact", "field": "email" }
      }
    }
  },
  "requestedSchema": {
    "type": "object",
    "required": ["delivery_email"],
    "properties": {
      "delivery_email": { "type": "string", "format": "email" }
    }
  }
}
```

Native `item/tool/requestUserInput` producers may instead provide request-level
`subject: "self"` and each question's `autofill: {section, field}`. The same
metadata on asynchronous `agentMessage` questions survives the RPC adapter.
`subject: "other"` explicitly disables account autofill. The only supported
sections/fields are:

- `personal`: `first_name`, `last_name`, `date_of_birth`, `gender`, `nationality`.
- `contact`: `email`, `phone`, `title`.
- `address`: `name`, `line1`, `line2`, `city`, `state`, `postal_code`, `country`.
- `travel`: `passport_number`, `passport_expiry`, `passport_country`.

Only text/select input fields qualify. Unknown/malformed metadata, duplicate
mappings, permission-only requests and secret questions never enable autofill.
Password, OTP and payment fields are not part of this contract. The account's
human form still validates and explicitly submits the current request; Cancel
and Decline send no answers. A profile save failure stops before sending the
answer, and the native runner still enforces the original schema and single use.
The native/local agent receives the answer it requested after submission, as it
did before this addition. This metadata transport adds no AI calls or prompt
text; its incremental inference cost is $0/day.
