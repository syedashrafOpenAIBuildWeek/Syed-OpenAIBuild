import { AppError } from "./errors.js";
import { config } from "./config.js";

async function structuredResponse(name, schema, instructions, input) {
  if (!process.env.OPENAI_API_KEY) throw new AppError("OPENAI_API_KEY is not configured", 503);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      instructions,
      input,
      text: { format: { type: "json_schema", name, strict: true, schema } },
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new AppError(body.error?.message || "OpenAI request failed", 502);
  const text = body.output_text ??
    body.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!text) throw new AppError("OpenAI response contained no structured output", 502);
  return JSON.parse(text);
}

const intentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "targetType", "objectApiName", "fieldApiNames"],
  properties: {
    action: { type: "string", enum: ["delete"] },
    targetType: { type: "string", enum: ["field", "object"] },
    objectApiName: { type: "string" },
    fieldApiNames: { type: "array", items: { type: "string" } },
  },
};

export function parseLiteralIntent(command) {
  const text = command.trim();
  let match = text.match(
    /^delete\s+(?:the\s+)?(?:custom\s+)?object\s+([A-Za-z][A-Za-z0-9_]*)\s*$/i
  );
  if (match) {
    return {
      action: "delete",
      targetType: "object",
      objectApiName: match[1],
      fieldApiNames: []
    };
  }
  match = text.match(
    /^delete\s+([A-Za-z][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z][A-Za-z0-9_]*)*)\s+from\s+([A-Za-z][A-Za-z0-9_]*)\s*$/i
  );
  if (match) {
    return {
      action: "delete",
      targetType: "field",
      objectApiName: match[2],
      fieldApiNames: match[1].split(/\s*,\s*/)
    };
  }
  match = text.match(
    /^delete\s+([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\s*$/i
  );
  if (match) {
    return {
      action: "delete",
      targetType: "field",
      objectApiName: match[1],
      fieldApiNames: [match[2]]
    };
  }
  return null;
}

export function parseIntent(command) {
  const literal = parseLiteralIntent(command);
  if (literal) return Promise.resolve(literal);
  return structuredResponse(
    "salesforce_delete_intent",
    intentSchema,
    "Extract a Salesforce deletion intent. Preserve API names exactly when supplied. For object deletion fieldApiNames must be empty. Reject ambiguity by returning the most literal interpretation; never invent multiple objects.",
    command,
  );
}

const editSchema = {
  type: "object",
  additionalProperties: false,
  required: ["updatedContent", "summary"],
  properties: {
    updatedContent: { type: "string" },
    summary: { type: "string" },
  },
};

export function removeReferences({ content, fileName, target }) {
  return structuredResponse(
    "metadata_reference_removal",
    editSchema,
    `Edit Salesforce metadata XML only. Remove every reference to ${target}. Keep all unrelated bytes and ordering as intact as possible. Return the complete valid file. Never add placeholders, comments, or unrelated cleanup.`,
    `FILE: ${fileName}\n\n${content}`,
  );
}
