import fs from "node:fs/promises";
import path from "node:path";
import { authorizeRun, persist } from "./store.js";
import {
  deleteRecord,
  deployDestructive,
  deploySource,
  query,
  retrieve
} from "./sf.js";
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

async function verifyLocalSnapshot(run) {
  if (!run.localSnapshot) return;
  const freshDir = path.join(run.dir, "approval-backup");
  await retrieve(run.metadataItems, freshDir);
  for (const item of run.diffs || []) {
    const [reviewed, current] = await Promise.all([
      fs.readFile(path.join(run.backupDir, item.file)),
      fs.readFile(path.join(freshDir, item.file))
    ]);
    if (!reviewed.equals(current)) {
      throw new AppError(
        `Metadata changed in Salesforce after the local review snapshot (${item.file}); analyze again`,
        409
      );
    }
  }
  await fs.rm(run.backupDir, { recursive: true, force: true });
  await fs.rename(freshDir, run.backupDir);
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
    await verifyLocalSnapshot(run);
    let validation = { skipped: true, reason: "No dependency fixes required" };
    let fixDeploy = { skipped: true, reason: "No dependency fixes required" };
    if (await hasFiles(run.workingDir)) {
      validation = await deploySource(run.workingDir, true);
      fixDeploy = await deploySource(run.workingDir, false);
    }
    let dependencyWorkspaceSync;
    try {
      dependencyWorkspaceSync = await syncDiffsToWorkspace(run, {
        includeDeletion: false
      });
    } catch (error) {
      dependencyWorkspaceSync = {
        connected: true,
        synced: [],
        deleted: [],
        manifests: [],
        alreadySatisfied: [],
        reviewArtifacts: [],
        skipped: [],
        error: error.message
      };
    }
    Object.assign(run, {
      validation,
      fixDeploy,
      workspaceSync: dependencyWorkspaceSync
    });
    await persist(run);
    const removedFlowVersions = await removeSupersededFlowVersions(run);
    run.removedFlowVersions = removedFlowVersions;
    await persist(run);
    const manifestDir = path.join(run.dir, "destructive");
    await fs.mkdir(manifestDir, { recursive: true });
    const manifests = destructiveManifests(
      run.actionable,
      run.emptiedComponents
    );
    const packageXml = path.join(manifestDir, "package.xml");
    const destructiveXml = path.join(manifestDir, "destructiveChangesPost.xml");
    await fs.writeFile(packageXml, manifests.packageXml, "utf8");
    await fs.writeFile(destructiveXml, manifests.destructiveXml, "utf8");
    const deletion = await deployDestructive(packageXml, destructiveXml);
    let workspaceSync;
    try {
      const finalSync = await syncDiffsToWorkspace(run, {
        manifests,
        includeDiffs: false
      });
      workspaceSync = {
        connected: dependencyWorkspaceSync.connected || finalSync.connected,
        synced: dependencyWorkspaceSync.synced || [],
        deleted: finalSync.deleted || [],
        manifests: finalSync.manifests || [],
        alreadySatisfied: dependencyWorkspaceSync.alreadySatisfied || [],
        reviewArtifacts: finalSync.reviewArtifacts || [],
        skipped: [
          ...(dependencyWorkspaceSync.skipped || []),
          ...(finalSync.skipped || [])
        ],
        ...(dependencyWorkspaceSync.error
          ? { error: dependencyWorkspaceSync.error }
          : {})
      };
    } catch (error) {
      workspaceSync = {
        connected: true,
        synced: [],
        deleted: [],
        manifests: [],
        alreadySatisfied: [],
        reviewArtifacts: [],
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
    const rollback = {};
    if (await hasFiles(run.backupDir)) {
      rollback.dependencies = await deploySource(run.backupDir, false);
    }
    if (run.targetBackupDir && (await hasFiles(run.targetBackupDir))) {
      rollback.target = await deploySource(run.targetBackupDir, false);
    }
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
