import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.js";
import { config, projectRoot } from "./config.js";

const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const COMPONENT_NAME = /^[A-Za-z0-9_./ ()-]+$/;

export function assertApiName(value, label = "API name") {
  if (!API_NAME.test(value || "")) throw new AppError(`Invalid ${label}: ${value}`);
  return value;
}

export function assertComponentName(value) {
  if (!COMPONENT_NAME.test(value || "") || value.includes("..")) {
    throw new AppError(`Unsafe metadata component name: ${value}`);
  }
  return value;
}

export function runSf(args, { cwd = projectRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("sf", [...args, "--json"], {
      cwd,
      env: { ...process.env, SF_USE_PROGRESS_BAR: "false" },
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => reject(new AppError(`Unable to start sf CLI: ${error.message}`, 500)));
    child.on("close", (code) => {
      let body;
      try {
        body = JSON.parse(stdout);
      } catch {
        return reject(new AppError("sf CLI returned invalid JSON", 502, { code, stderr, stdout }));
      }
      if (code !== 0 || body.status) {
        return reject(new AppError(body.message || "Salesforce CLI command failed", 502, {
          code,
          command: ["sf", ...args].join(" "),
          stderr,
          result: body.result,
        }));
      }
      resolve(body.result);
    });
  });
}

export const describe = (objectApiName) =>
  runSf(["sobject", "describe", "--target-org", config.orgAlias, "--sobject", assertApiName(objectApiName)]);

export const query = (soql, tooling = false) =>
  runSf([
    "data", "query", "--target-org", config.orgAlias,
    ...(tooling ? ["--use-tooling-api"] : []),
    "--query", soql,
  ]);

async function listFilesRecursive(dir) {
  let out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(await listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

// `--output-dir` pointing outside force-app silently retrieves nothing on
// this CLI/org combination (no error, just an empty result) for reasons that
// didn't resolve under time pressure. Retrieving into the project's default
// package directory works reliably, so retrieve there and move the new files
// out to the requested location instead.
export async function retrieve(metadata, outputDir) {
  const defaultDir = path.join(projectRoot, "force-app", "main", "default");
  const before = new Set(await listFilesRecursive(defaultDir));
  await runSf([
    "project", "retrieve", "start", "--target-org", config.orgAlias,
    ...metadata.flatMap((item) => ["--metadata", `${item.type}:${assertComponentName(item.name)}`]),
    "--wait", "30",
  ]);
  const after = await listFilesRecursive(defaultDir);
  const newFiles = after.filter((file) => !before.has(file));
  await fs.mkdir(outputDir, { recursive: true });
  for (const file of newFiles) {
    const rel = path.relative(defaultDir, file);
    const dest = path.join(outputDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(file, dest);
  }
}

export const deploySource = (sourceDir, dryRun = false) =>
  runSf([
    "project", "deploy", "start", "--target-org", config.orgAlias,
    "--source-dir", sourceDir, ...(dryRun ? ["--dry-run"] : []), "--wait", "30",
  ]);

export const deployDestructive = (packageXml, destructiveXml) =>
  runSf([
    "project", "deploy", "start", "--target-org", config.orgAlias,
    "--manifest", packageXml, "--post-destructive-changes", destructiveXml, "--wait", "30",
  ]);
