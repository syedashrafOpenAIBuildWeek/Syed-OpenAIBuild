import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./config.js";

async function readFile(file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function findDefaultPackageDirectory(root = projectRoot) {
  try {
    const project = JSON.parse(
      await fs.readFile(path.join(root, "sfdx-project.json"), "utf8")
    );
    const directories = project.packageDirectories || [];
    const selected = directories.find((item) => item.default) || directories[0];
    if (!selected?.path) return null;
    return path.join(root, selected.path, "main", "default");
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function syncDiffsToWorkspace(
  run,
  {
    root = projectRoot,
    manifests,
    includeDiffs = true,
    includeDeletion = true
  } = {}
) {
  const metadataRoot = await findDefaultPackageDirectory(root);
  if (!metadataRoot) {
    return {
      connected: false,
      synced: [],
      deleted: [],
      manifests: [],
      alreadySatisfied: [],
      reviewArtifacts: [],
      skipped: []
    };
  }

  const synced = [];
  const deleted = [];
  const alreadySatisfied = [];
  const skipped = [];
  for (const item of includeDiffs ? run.diffs || [] : []) {
    const relativeFile = item.file;
    const backupFile = path.join(run.backupDir, relativeFile);
    const workingFile = path.join(run.workingDir, relativeFile);
    const workspaceFile = path.join(metadataRoot, relativeFile);
    const [backupContent, workingContent, workspaceContent] = await Promise.all(
      [readFile(backupFile), readFile(workingFile), readFile(workspaceFile)]
    );

    if (!workingContent) {
      skipped.push({
        file: relativeFile,
        reason: "Generated metadata file was not found"
      });
      continue;
    }
    if (
      workspaceContent &&
      backupContent &&
      !workspaceContent.equals(backupContent)
    ) {
      const localText = workspaceContent.toString("utf8");
      const stillReferencesTarget = (run.actionable || []).some((target) => {
        const bareName =
          target.targetType === "field"
            ? target.fieldApiName
            : target.objectApiName;
        return (
          localText.includes(target.fullName) || localText.includes(bareName)
        );
      });
      if (!stillReferencesTarget) {
        alreadySatisfied.push(path.relative(root, workspaceFile));
        continue;
      }
      skipped.push({
        file: relativeFile,
        reason: "Local file differs from the retrieved org version"
      });
      continue;
    }

    await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
    await fs.writeFile(workspaceFile, workingContent);
    synced.push(path.relative(root, workspaceFile));
  }

  for (const target of includeDeletion ? run.actionable || [] : []) {
    if (target.targetType !== "field") {
      skipped.push({
        file: `objects/${target.objectApiName}`,
        reason:
          "Object source directories are not removed automatically; use the generated destructive manifest"
      });
      continue;
    }
    const relativeFile = path.join(
      "objects",
      target.objectApiName,
      "fields",
      `${target.fieldApiName}.field-meta.xml`
    );
    const workspaceFile = path.join(metadataRoot, relativeFile);
    try {
      await fs.unlink(workspaceFile);
      deleted.push(path.relative(root, workspaceFile));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const manifestFiles = [];
  const reviewArtifacts = [];
  if (manifests) {
    const manifestDir = path.join(root, "manifest", "safeMetadataDelete");
    await fs.mkdir(manifestDir, { recursive: true });
    for (const [name, content] of [
      ["package.xml", manifests.packageXml],
      ["destructiveChangesPost.xml", manifests.destructiveXml]
    ]) {
      const file = path.join(manifestDir, name);
      await fs.writeFile(file, content, "utf8");
      manifestFiles.push(path.relative(root, file));
    }
    const reviewDir = path.join(manifestDir, "review");
    await fs.mkdir(reviewDir, { recursive: true });
    for (const item of run.diffs || []) {
      const artifactName = `${item.file.replaceAll(/[^A-Za-z0-9_.-]/g, "_")}.patch`;
      const file = path.join(reviewDir, artifactName);
      await fs.writeFile(file, `${item.summary}\n\n${item.diff}`, "utf8");
      reviewArtifacts.push(path.relative(root, file));
    }
  }

  return {
    connected: true,
    synced,
    deleted,
    manifests: manifestFiles,
    alreadySatisfied,
    reviewArtifacts,
    skipped
  };
}
