import path from "node:path";

export const projectRoot = path.resolve(import.meta.dirname, "..");
export const runsRoot = path.join(projectRoot, ".safe-delete", "runs");
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
