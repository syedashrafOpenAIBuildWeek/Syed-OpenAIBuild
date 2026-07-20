import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runsRoot } from "./config.js";
import { AppError } from "./errors.js";

const runs = new Map();

export async function createRun(command, intent) {
  const id = crypto.randomUUID();
  const approvalToken = crypto.randomBytes(32).toString("hex");
  const dir = path.join(runsRoot, id);
  const run = { id, approvalToken, command, intent, dir, state: "planning", createdAt: new Date().toISOString() };
  runs.set(id, run);
  await fs.mkdir(dir, { recursive: true });
  return run;
}

export function getRun(id) {
  const run = runs.get(id);
  if (!run) throw new AppError("Run not found or backend restarted", 404);
  return run;
}

export function authorizeRun(id, token, allowedStates) {
  const run = getRun(id);
  const supplied = Buffer.from(token || "");
  const expected = Buffer.from(run.approvalToken);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw new AppError("Invalid approval token", 403);
  }
  if (!allowedStates.includes(run.state)) throw new AppError(`Run is ${run.state}`, 409);
  return run;
}

export async function persist(run) {
  const safe = { ...run, approvalToken: undefined };
  await fs.writeFile(path.join(run.dir, "run.json"), JSON.stringify(safe, null, 2), "utf8");
}
