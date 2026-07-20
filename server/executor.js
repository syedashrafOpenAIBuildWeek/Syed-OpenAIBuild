import fs from "node:fs/promises";
import path from "node:path";
import { authorizeRun, persist } from "./store.js";
import { deleteRecord, deployDestructive, deploySource, query } from "./sf.js";
import { destructiveManifests } from "./xml.js";
import { syncDiffsToWorkspace } from "./workspace.js";
import { AppError } from "./errors.js";

const quoteSoql = (value) =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const records = (result) => result.records || result.result?.records || [];

async function hasFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && (await hasFiles(path.join(dir, entry.name))))
      return true;
  }
  return false;
}

async function removeSupersededFlowVersions(run) {
  const versions = new Map();
  for (const target of run.actionable || []) {
    for (const version of target.flowVersionCleanup || []) {
      versions.set(version.id, version);
    }
  }
  const removed = [];
  for (const version of versions.values()) {
    const found = records(
      await query(
        `SELECT Id, Status, VersionNumber FROM Flow WHERE Id = ${quoteSoql(version.id)}`,
        true
      )
    )[0];
    if (!found) continue;
    if (found.Status === "Active") {
      throw new AppError(
        `Corrected Flow "${version.name}" was not activated; refusing to delete its active version`,
        409
      );
    }
    await deleteRecord("Flow", found.Id, true);
    removed.push({
      id: found.Id,
      name: version.name,
      versionNumber: found.VersionNumber,
      previousStatus: found.Status
    });
  }
  return removed;
}

export async function approve(id, token) {
  const run = authorizeRun(id, token, ["awaiting_approval"]);
  run.state = "executing";
  await persist(run);
  try {
    let validation = { skipped: true, reason: "No dependency fixes required" };
    let fixDeploy = { skipped: true, reason: "No dependency fixes required" };
    if (await hasFiles(run.workingDir)) {
      validation = await deploySource(run.workingDir, true);
      fixDeploy = await deploySource(run.workingDir, false);
    }
    Object.assign(run, { validation, fixDeploy });
    await persist(run);
    const removedFlowVersions = await removeSupersededFlowVersions(run);
    run.removedFlowVersions = removedFlowVersions;
    await persist(run);
    const manifestDir = path.join(run.dir, "destructive");
    await fs.mkdir(manifestDir, { recursive: true });
    const manifests = destructiveManifests(run.actionable);
    const packageXml = path.join(manifestDir, "package.xml");
    const destructiveXml = path.join(manifestDir, "destructiveChangesPost.xml");
    await fs.writeFile(packageXml, manifests.packageXml, "utf8");
    await fs.writeFile(destructiveXml, manifests.destructiveXml, "utf8");
    const deletion = await deployDestructive(packageXml, destructiveXml);
    let workspaceSync;
    try {
      workspaceSync = await syncDiffsToWorkspace(run, { manifests });
    } catch (error) {
      workspaceSync = {
        connected: true,
        synced: [],
        deleted: [],
        manifests: [],
        skipped: [],
        error: error.message
      };
    }
    Object.assign(run, {
      state: "completed",
      validation,
      fixDeploy,
      deletion,
      removedFlowVersions,
      workspaceSync
    });
    await persist(run);
    return {
      status: run.state,
      validation,
      fixDeploy,
      deletion,
      removedFlowVersions,
      workspaceSync
    };
  } catch (error) {
    run.state = "failed";
    run.failure = { message: error.message, details: error.details };
    await persist(run);
    throw error;
  }
}

export async function rollback(id, token) {
  const run = authorizeRun(id, token, ["failed"]);
  run.state = "rolling_back";
  await persist(run);
  try {
    const rollback = await deploySource(run.backupDir, false);
    Object.assign(run, { state: "rolled_back", rollback });
    await persist(run);
    return { status: run.state, rollback };
  } catch (error) {
    run.state = "rollback_failed";
    run.rollbackFailure = { message: error.message, details: error.details };
    await persist(run);
    throw error;
  }
}
