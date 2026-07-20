import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertApiName, describe, query, retrieve } from "./sf.js";
import { removeReferences } from "./openai.js";
import { createRun, persist } from "./store.js";
import { AppError } from "./errors.js";

const execFileAsync = promisify(execFile);
const AUTO_TYPES = new Set([
  "ApexClass",
  "ApexTrigger",
  "AuraDefinitionBundle",
  "CustomApplication",
  "CustomPermission",
  "EmailTemplate",
  "Flow",
  "Layout",
  "ListView",
  "PermissionSet",
  "Profile",
  "Report",
  "ValidationRule",
  "FlexiPage",
  "Workflow"
]);

const quoteSoql = (value) =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const records = (result) => result.records || result.result?.records || [];

function normalizeIntent(intent) {
  assertApiName(intent.objectApiName, "object API name");
  if (intent.action !== "delete")
    throw new AppError("Only delete commands are supported");
  if (intent.targetType === "object" && intent.fieldApiNames.length) {
    throw new AppError("Object deletion cannot include field names");
  }
  if (intent.targetType === "field" && !intent.fieldApiNames.length) {
    throw new AppError("At least one field API name is required");
  }
  intent.fieldApiNames.forEach((name) => assertApiName(name, "field API name"));
  return intent;
}

const developerNameFor = (apiName) =>
  apiName.endsWith("__c") ? apiName.slice(0, -3) : apiName;

// MetadataComponentDependency rejects WHERE filters on RefMetadataComponentName
// ("... is unknown") - only RefMetadataComponentId is filterable, so the
// target's Tooling API Id has to be resolved first.
async function resolveComponentId(fullName, targetType) {
  const soql =
    targetType === "field"
      ? (() => {
          const split = fullName.lastIndexOf(".");
          const objectApiName = fullName.slice(0, split);
          const fieldApiName = fullName.slice(split + 1);
          return (
            "SELECT Id FROM CustomField WHERE DeveloperName = " +
            `${quoteSoql(developerNameFor(fieldApiName))} AND TableEnumOrId = ${quoteSoql(objectApiName)}`
          );
        })()
      : `SELECT Id FROM CustomObject WHERE DeveloperName = ${quoteSoql(developerNameFor(fullName))}`;
  const rows = records(await query(soql, true));
  if (!rows.length)
    throw new AppError(`Could not resolve ${fullName} in the Tooling API`);
  return rows[0].Id;
}

// The dependency query only returns a display name (e.g. "Lead Layout"),
// not the fully-qualified name retrieval/deploy require (e.g.
// "Lead-Lead Layout"). Each metadata type resolves that qualifier differently.
async function resolveRetrieveNames(rows) {
  const resolved = new Map();
  rows
    .filter((row) => row.ResolvedFullName)
    .forEach((row) =>
      resolved.set(
        `${row.MetadataComponentType}:${row.MetadataComponentId}`,
        row.ResolvedFullName
      )
    );
  const groups = new Map();
  rows
    .filter(
      (row) =>
        AUTO_TYPES.has(row.MetadataComponentType) && !row.ResolvedFullName
    )
    .forEach((row) => {
      const typeRows = groups.get(row.MetadataComponentType) || [];
      typeRows.push(row);
      groups.set(row.MetadataComponentType, typeRows);
    });
  await Promise.all(
    [...groups].map(async ([type, items]) => {
      const ids = [...new Set(items.map((item) => item.MetadataComponentId))];
      if (type === "ListView") {
        const found = records(
          await query(
            `SELECT Id, DeveloperName, SobjectType FROM ListView WHERE Id IN (${ids.map(quoteSoql).join(",")})`
          )
        );
        found.forEach((item) =>
          resolved.set(
            `${type}:${item.Id}`,
            `${item.SobjectType}.${item.DeveloperName}`
          )
        );
        return;
      }
      // Tooling API rejects batching IDs when selecting FullName ("must
      // specify no more than one row for retrieval") - query them one at a
      // time, in parallel.
      await Promise.all(
        ids.map(async (id) => {
          try {
            const found = records(
              await query(
                `SELECT Id, FullName FROM ${type} WHERE Id = ${quoteSoql(id)}`,
                true
              )
            );
            if (found.length)
              resolved.set(
                `${type}:${id}`,
                decodeURIComponent(found[0].FullName)
              );
          } catch {
            // Unsupported Tooling API types remain visible as manual-review
            // dependencies instead of hiding the dependencies we can edit.
          }
        })
      );
    })
  );
  return resolved;
}

function retrieveDependency(row, resolved, flowVersions) {
  const type = row.MetadataComponentType;
  const retrieveName = resolved.get(`${type}:${row.MetadataComponentId}`);
  const flowVersion = flowVersions.get(row.MetadataComponentId);
  return {
    name: row.MetadataComponentName,
    type,
    componentId: row.MetadataComponentId,
    retrieveName: retrieveName || row.MetadataComponentName,
    autoFixable:
      AUTO_TYPES.has(type) &&
      Boolean(retrieveName) &&
      (type !== "Flow" || Boolean(flowVersion)),
    flowStatus: flowVersion?.Status,
    flowVersionNumber: flowVersion?.VersionNumber,
    cleanupOnly: type === "Flow" && flowVersion?.Status !== "Active"
  };
}

export function flexiPageMetadataReferences(metadata, fieldApiName) {
  const serialized = JSON.stringify(metadata || {});
  return (
    serialized.includes(`Record.${fieldApiName}`) ||
    serialized.includes(`"${fieldApiName}"`)
  );
}

async function flexiPageDependencies(fullName, targetType) {
  if (targetType !== "field") return [];
  const split = fullName.lastIndexOf(".");
  const objectApiName = fullName.slice(0, split);
  const fieldApiName = fullName.slice(split + 1);
  const pages = records(
    await query(
      "SELECT Id, DeveloperName, MasterLabel, Type, EntityDefinitionId " +
        `FROM FlexiPage WHERE EntityDefinitionId = ${quoteSoql(objectApiName)}`,
      true
    )
  );
  const matches = await Promise.all(
    pages.map(async (page) => {
      const found = records(
        await query(
          `SELECT Id, Metadata FROM FlexiPage WHERE Id = ${quoteSoql(page.Id)}`,
          true
        )
      )[0];
      if (!flexiPageMetadataReferences(found?.Metadata, fieldApiName)) {
        return null;
      }
      return {
        MetadataComponentId: page.Id,
        MetadataComponentName: page.MasterLabel,
        MetadataComponentType: "FlexiPage",
        ResolvedFullName: page.DeveloperName
      };
    })
  );
  return matches.filter(Boolean);
}

async function dependencies(fullName, targetType) {
  const componentId = await resolveComponentId(fullName, targetType);
  const soql =
    "SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType " +
    `FROM MetadataComponentDependency WHERE RefMetadataComponentId = ${quoteSoql(componentId)}`;
  const [standardRows, flexiPageRows] = await Promise.all([
    query(soql, true).then(records),
    flexiPageDependencies(fullName, targetType)
  ]);
  const rowsById = new Map();
  [...standardRows, ...flexiPageRows].forEach((row) =>
    rowsById.set(`${row.MetadataComponentType}:${row.MetadataComponentId}`, row)
  );
  const rows = [...rowsById.values()];
  const [resolved, flowVersionRows] = await Promise.all([
    resolveRetrieveNames(rows),
    Promise.all(
      rows
        .filter((row) => row.MetadataComponentType === "Flow")
        .map(async (row) => {
          const found = records(
            await query(
              `SELECT Id, Status, VersionNumber FROM Flow WHERE Id = ${quoteSoql(row.MetadataComponentId)}`,
              true
            )
          )[0];
          return found;
        })
    )
  ]);
  const flowVersions = new Map(
    flowVersionRows.filter(Boolean).map((item) => [item.Id, item])
  );
  return rows.map((row) => retrieveDependency(row, resolved, flowVersions));
}

async function incomingRelationships(objectApiName, deps) {
  const candidates = deps.filter(
    (dep) => dep.type === "CustomField" && dep.name?.includes(".")
  );
  const possible = await Promise.all(
    candidates.map(async (dep) => {
      const split = dep.name.lastIndexOf(".");
      const sourceObject = dep.name.slice(0, split);
      const fieldName = dep.name.slice(split + 1);
      if (sourceObject === objectApiName) return null;
      const source = await describe(sourceObject);
      const field = source.fields?.find((item) => item.name === fieldName);
      if (!field?.referenceTo?.includes(objectApiName)) return null;
      return {
        objectApiName: sourceObject,
        fieldApiName: fieldName,
        relationshipType: field.type
      };
    })
  );
  return possible.filter(Boolean);
}

function targetFromField(objectApiName, field) {
  return {
    targetType: "field",
    objectApiName,
    fieldApiName: field.name,
    fullName: `${objectApiName}.${field.name}`,
    custom: Boolean(field.custom)
  };
}

async function walk(dir) {
  const output = [];
  const textExtensions = new Set([
    ".cls",
    ".cmp",
    ".component",
    ".css",
    ".email",
    ".html",
    ".js",
    ".page",
    ".trigger",
    ".xml"
  ]);
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(file)));
    else if (textExtensions.has(path.extname(entry.name))) output.push(file);
  }
  return output;
}

async function makeDiff(beforeFile, afterFile, root) {
  try {
    await execFileAsync("diff", [
      "-u",
      "--label",
      `before/${path.relative(root, beforeFile)}`,
      "--label",
      `after/${path.relative(root, afterFile)}`,
      beforeFile,
      afterFile
    ]);
    return "";
  } catch (error) {
    if (error.code === 1) return error.stdout;
    throw error;
  }
}

export async function buildPlan(command, intent) {
  intent = normalizeIntent(intent);
  const object = await describe(intent.objectApiName);
  const allTargets =
    intent.targetType === "object"
      ? [
          {
            targetType: "object",
            objectApiName: object.name,
            fullName: object.name,
            custom: Boolean(object.custom)
          }
        ]
      : intent.fieldApiNames.map((name) => {
          const field = object.fields?.find(
            (item) => item.name.toLowerCase() === name.toLowerCase()
          );
          if (!field)
            return {
              targetType: "field",
              objectApiName: object.name,
              fieldApiName: name,
              fullName: `${object.name}.${name}`,
              missing: true
            };
          return targetFromField(object.name, field);
        });

  const blocked = allTargets
    .filter((target) => target.missing || !target.custom)
    .map((target) => ({
      ...target,
      reason: target.missing
        ? "Field was not found"
        : "Standard metadata cannot be deleted"
    }));
  const candidates = allTargets.filter((target) => target.custom);
  if (!candidates.length)
    return { status: "blocked", intent, blocked, targets: [] };

  const run = await createRun(command, intent);
  // Each target's dependency scan is independent of the others - scanning
  // them one at a time serialized the whole plan on network round-trips
  // for no reason.
  const planned = await Promise.all(
    candidates.map(async (target) => {
      const deps = await dependencies(target.fullName, target.targetType);
      const manual = deps.filter((dep) => !dep.autoFixable);
      let recordCount;
      let relationships = [];
      if (target.targetType === "object") {
        const [countResult, foundRelationships] = await Promise.all([
          // COUNT() (no field) can't take an alias - COUNT(Id) can.
          query(
            `SELECT COUNT(Id) total FROM ${assertApiName(target.objectApiName)}`
          ),
          incomingRelationships(target.objectApiName, deps)
        ]);
        recordCount = records(countResult)[0]?.total;
        relationships = foundRelationships;
      }
      const hardBlocked = manual.length > 0 || relationships.length > 0;
      return {
        ...target,
        dependencies: deps,
        flowVersionCleanup: deps
          .filter((dep) => dep.type === "Flow")
          .map((dep) => ({
            id: dep.componentId,
            name: dep.name,
            status: dep.flowStatus,
            versionNumber: dep.flowVersionNumber,
            cleanupOnly: dep.cleanupOnly
          })),
        manualReview: manual,
        incomingRelationships: relationships,
        recordCount,
        hardBlocked
      };
    })
  );
  const metadata = new Map();
  for (const target of planned) {
    if (target.hardBlocked) continue;
    target.dependencies
      .filter((dep) => dep.autoFixable && !dep.cleanupOnly)
      .forEach((dep) =>
        metadata.set(`${dep.type}:${dep.retrieveName}`, {
          type: dep.type,
          name: dep.retrieveName
        })
      );
  }
  const actionable = planned.filter((target) => !target.hardBlocked);
  if (!actionable.length) {
    run.state = "blocked";
    Object.assign(run, { blocked, targets: planned });
    await persist(run);
    return publicPlan(run);
  }

  const backupDir = path.join(run.dir, "backup");
  const workingDir = path.join(run.dir, "working");
  const metadataItems = [...metadata.values()];
  let diffs = [];
  if (metadataItems.length) {
    await retrieve(metadataItems, backupDir);
    await fs.cp(backupDir, workingDir, { recursive: true });
    // Different files are independent, so diff them concurrently rather than
    // waiting on one GPT-5.6 call at a time. Edits to the *same* file from
    // multiple targets still have to apply in sequence (each builds on the
    // last one's output), so that inner loop stays sequential.
    const perFile = await Promise.all(
      (await walk(backupDir)).map(async (file) => {
        const content = await fs.readFile(file, "utf8");
        // Layouts/validation rules/list views reference fields by their bare
        // API name (e.g. "CurrentGenerators__c"), not "Object.Field" - check
        // both forms rather than only the fully-qualified one.
        const relevant = actionable.filter((target) => {
          const bareName =
            target.targetType === "field"
              ? target.fieldApiName
              : target.objectApiName;
          return (
            content.includes(target.fullName) || content.includes(bareName)
          );
        });
        if (!relevant.length) return null;
        const edit = await removeReferences({
          content,
          fileName: path.relative(backupDir, file),
          targets: relevant.map((target) => target.fullName)
        });
        const updatedContent = edit.updatedContent;
        const output = path.join(workingDir, path.relative(backupDir, file));
        await fs.writeFile(output, updatedContent, "utf8");
        const diff = await makeDiff(file, output, run.dir);
        if (!diff) return null;
        return {
          file: path.relative(backupDir, file),
          diff,
          summary: edit.summary
        };
      })
    );
    diffs = perFile.filter(Boolean);
  } else {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.mkdir(workingDir, { recursive: true });
  }
  Object.assign(run, {
    state: "awaiting_approval",
    blocked,
    targets: planned,
    actionable,
    backupDir,
    workingDir,
    diffs
  });
  await persist(run);
  return publicPlan(run);
}

export function publicPlan(run) {
  return {
    runId: run.id,
    approvalToken:
      run.state === "awaiting_approval" ? run.approvalToken : undefined,
    status: run.state,
    intent: run.intent,
    blocked: run.blocked || [],
    targets: run.targets || [],
    diffs: run.diffs || []
  };
}
