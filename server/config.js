import os from "node:os";
import path from "node:path";

export const projectRoot = path.resolve(import.meta.dirname, "..");
// `sf project deploy start` silently treats gitignored paths as having no
// changes to deploy, even when pointed at them explicitly via --source-dir
// ("No local changes to deploy") - run artifacts have to live outside the
// git working tree entirely, not just be gitignored inside it.
export const runsRoot = path.join(os.tmpdir(), "safe-metadata-delete-runs");
export const config = {
  orgAlias: process.env.SF_ORG_ALIAS || "hackathon-org",
  model: process.env.OPENAI_MODEL || "gpt-5.6",
  port: Number(process.env.PORT || 3001),
  apiToken: process.env.BACKEND_API_TOKEN || "",
  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:3000")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
};
