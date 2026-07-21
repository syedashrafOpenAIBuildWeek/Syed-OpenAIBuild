import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.js";
import { config, projectRoot } from "./config.js";

const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const COMPONENT_NAME = /^[A-Za-z0-9_./ ()-]+$/;

export function assertApiName(value, label = "API name") {
  if (!API_NAME.test(value || ""))
    throw new AppError(`Invalid ${label}: ${value}`);
  return value;
}

export function assertComponentName(value) {
  if (!COMPONENT_NAME.test(value || "") || value.includes("..")) {
    throw new AppError(`Unsafe metadata component name: ${value}`);
  }
  return value;
}

// The sf CLI is memory-heavy (each invocation is its own Node process), and
// this code fires off several in parallel (dependency scans, per-dependency
// retrieve-name lookups). Unbounded concurrency was OOM-killing the 512MB
// free-tier container, so cap how many sf processes can run at once
// regardless of how much logical parallelism exists upstream.
// Two CLI workers substantially reduce planning latency while remaining
// conservative for small containers. Operators on tighter hosts can restore
// single-process behavior with SF_MAX_CONCURRENCY=1.
const configuredSfConcurrency = Number(process.env.SF_MAX_CONCURRENCY || 2);
const MAX_CONCURRENT_SF =
  Number.isInteger(configuredSfConcurrency) && configuredSfConcurrency > 0
    ? configuredSfConcurrency
    : 2;
let activeSf = 0;
const sfQueue = [];

function runQueued(fn) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      activeSf += 1;
      fn()
        .then(resolve, reject)
        .finally(() => {
          activeSf -= 1;
          const next = sfQueue.shift();
          if (next) next();
        });
    };
    if (activeSf < MAX_CONCURRENT_SF) attempt();
    else sfQueue.push(attempt);
  });
}

export function runSf(args, options = {}) {
  return runQueued(() => runSfNow(args, options));
}

function runSfNow(args, { cwd = projectRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("sf", [...args, "--json"], {
      cwd,
      env: { ...process.env, SF_USE_PROGRESS_BAR: "false" },
      shell: false
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) =>
      reject(new AppError(`Unable to start sf CLI: ${error.message}`, 500))
    );
    child.on("close", (code) => {
      let body;
      try {
        body = JSON.parse(stdout);
      } catch {
        return reject(
          new AppError("sf CLI returned invalid JSON", 502, {
            code,
            stderr,
            stdout
          })
        );
      }
      if (code !== 0 || body.status) {
        return reject(
          new AppError(body.message || "Salesforce CLI command failed", 502, {
            code,
            command: ["sf", ...args].join(" "),
            stderr,
            result: body.result
          })
        );
      }
      resolve(body.result);
    });
  });
}

const SESSION_TTL_MS = Number(process.env.SF_SESSION_TTL_MS || 5 * 60 * 1000);
let sessionPromise;
let sessionExpiresAt = 0;

async function orgSession(forceRefresh = false) {
  const now = Date.now();
  if (forceRefresh || !sessionPromise || now >= sessionExpiresAt) {
    sessionExpiresAt = now + SESSION_TTL_MS;
    sessionPromise = runSf([
      "org",
      "display",
      "--target-org",
      config.orgAlias,
      "--verbose"
    ]).catch((error) => {
      sessionPromise = undefined;
      sessionExpiresAt = 0;
      throw error;
    });
  }
  return sessionPromise;
}

async function salesforceRequest(pathname, forceRefresh = false) {
  const session = await orgSession(forceRefresh);
  const response = await fetch(`${session.instanceUrl}${pathname}`, {
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      Accept: "application/json"
    }
  });
  if (response.status === 401 && !forceRefresh) {
    return salesforceRequest(pathname, true);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = Array.isArray(body) ? body[0] : body;
    throw new AppError(
      details?.message || `Salesforce API returned ${response.status}`,
      502,
      { status: response.status, errorCode: details?.errorCode }
    );
  }
  return body;
}

// Planning performs many small reads. Calling the REST APIs through one
// short-lived authenticated session avoids launching a new sf CLI process for
// every query while preserving the CLI-backed deploy/delete safety path.
export async function describe(objectApiName) {
  const session = await orgSession();
  return salesforceRequest(
    `/services/data/v${session.apiVersion}/sobjects/${encodeURIComponent(
      assertApiName(objectApiName)
    )}/describe`
  );
}

export async function query(soql, tooling = false) {
  const session = await orgSession();
  const api = tooling ? "tooling/query" : "query";
  return salesforceRequest(
    `/services/data/v${session.apiVersion}/${api}?q=${encodeURIComponent(soql)}`
  );
}

// Reports aren't queryable via the Tooling API at all ("sObject type
// 'Report' is not supported"), so field references inside them can't be
// found via MetadataComponentDependency or resolved to a retrieve name the
// way Layout/ValidationRule are. The Analytics REST describe endpoint is the
// only reliable way to see what a report actually references.
export async function describeReport(reportId) {
  const session = await orgSession();
  return salesforceRequest(
    `/services/data/v${session.apiVersion}/analytics/reports/${encodeURIComponent(reportId)}/describe`
  );
}

export const deleteRecord = (sobject, recordId, tooling = false) =>
  runSf([
    "data",
    "delete",
    "record",
    "--target-org",
    config.orgAlias,
    ...(tooling ? ["--use-tooling-api"] : []),
    "--sobject",
    assertApiName(sobject, "sObject API name"),
    "--record-id",
    recordId
  ]);

export async function retrieve(metadata, outputDir) {
  const stagingDir = path.join(
    projectRoot,
    "safe-delete-runs",
    "retrievals",
    crypto.randomUUID()
  );
  await fs.mkdir(path.dirname(stagingDir), { recursive: true });
  try {
    await runSf([
      "project",
      "retrieve",
      "start",
      "--target-org",
      config.orgAlias,
      "--output-dir",
      stagingDir,
      ...metadata.flatMap((item) => [
        "--metadata",
        `${item.type}:${assertComponentName(item.name)}`
      ]),
      "--wait",
      "30"
    ]);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.cp(stagingDir, outputDir, { recursive: true });
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

export const deploySource = (sourceDir, dryRun = false) =>
  runSf([
    "project",
    "deploy",
    "start",
    "--target-org",
    config.orgAlias,
    "--source-dir",
    sourceDir,
    ...(dryRun ? ["--dry-run"] : []),
    "--wait",
    "30"
  ]);

export const deployDestructive = (packageXml, destructiveXml) =>
  runSf([
    "project",
    "deploy",
    "start",
    "--target-org",
    config.orgAlias,
    "--manifest",
    packageXml,
    "--post-destructive-changes",
    destructiveXml,
    "--wait",
    "30"
  ]);
