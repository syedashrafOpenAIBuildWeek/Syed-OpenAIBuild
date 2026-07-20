import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncDiffsToWorkspace } from "../workspace.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-delete-"));
  const backupDir = path.join(root, "run", "backup");
  const workingDir = path.join(root, "run", "working");
  const relativeFile = "layouts/Account-Test.layout-meta.xml";
  await fs.mkdir(path.dirname(path.join(backupDir, relativeFile)), {
    recursive: true
  });
  await fs.mkdir(path.dirname(path.join(workingDir, relativeFile)), {
    recursive: true
  });
  await fs.writeFile(
    path.join(root, "sfdx-project.json"),
    JSON.stringify({
      packageDirectories: [{ path: "force-app", default: true }]
    })
  );
  await fs.writeFile(path.join(backupDir, relativeFile), "before");
  await fs.writeFile(path.join(workingDir, relativeFile), "after");
  return {
    root,
    backupDir,
    workingDir,
    relativeFile,
    diffs: [{ file: relativeFile }],
    actionable: []
  };
}

test("copies generated metadata into a Salesforce project", async (t) => {
  const run = await fixture();
  t.after(() => fs.rm(run.root, { recursive: true, force: true }));

  const result = await syncDiffsToWorkspace(run, { root: run.root });

  assert.deepEqual(result.synced, [
    "force-app/main/default/layouts/Account-Test.layout-meta.xml"
  ]);
  assert.equal(
    await fs.readFile(
      path.join(run.root, "force-app/main/default", run.relativeFile),
      "utf8"
    ),
    "after"
  );
});

test("does not overwrite a locally modified metadata file", async (t) => {
  const run = await fixture();
  t.after(() => fs.rm(run.root, { recursive: true, force: true }));
  const localFile = path.join(
    run.root,
    "force-app/main/default",
    run.relativeFile
  );
  await fs.mkdir(path.dirname(localFile), { recursive: true });
  await fs.writeFile(localFile, "local change Safe_Date__c");
  run.actionable = [
    {
      targetType: "field",
      objectApiName: "Lead",
      fieldApiName: "Safe_Date__c",
      fullName: "Lead.Safe_Date__c"
    }
  ];

  const result = await syncDiffsToWorkspace(run, { root: run.root });

  assert.equal(result.synced.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(
    await fs.readFile(localFile, "utf8"),
    "local change Safe_Date__c"
  );
});

test("recognizes a divergent local file that already removed the target", async (t) => {
  const run = await fixture();
  t.after(() => fs.rm(run.root, { recursive: true, force: true }));
  const localFile = path.join(
    run.root,
    "force-app/main/default",
    run.relativeFile
  );
  await fs.mkdir(path.dirname(localFile), { recursive: true });
  await fs.writeFile(localFile, "unrelated local content");
  run.actionable = [
    {
      targetType: "field",
      objectApiName: "Lead",
      fieldApiName: "Safe_Date__c",
      fullName: "Lead.Safe_Date__c"
    }
  ];

  const result = await syncDiffsToWorkspace(run, {
    root: run.root,
    includeDeletion: false
  });

  assert.deepEqual(result.alreadySatisfied, [
    "force-app/main/default/layouts/Account-Test.layout-meta.xml"
  ]);
  assert.equal(result.skipped.length, 0);
  assert.equal(await fs.readFile(localFile, "utf8"), "unrelated local content");
});

test("keeps existing behavior outside a Salesforce project", async (t) => {
  const run = await fixture();
  t.after(() => fs.rm(run.root, { recursive: true, force: true }));
  await fs.rm(path.join(run.root, "sfdx-project.json"));

  const result = await syncDiffsToWorkspace(run, { root: run.root });

  assert.equal(result.connected, false);
  assert.deepEqual(result.synced, []);
});

test("removes a deleted field and writes destructive manifests", async (t) => {
  const run = await fixture();
  t.after(() => fs.rm(run.root, { recursive: true, force: true }));
  const fieldFile = path.join(
    run.root,
    "force-app/main/default/objects/Lead/fields/TestCheckbox__c.field-meta.xml"
  );
  await fs.mkdir(path.dirname(fieldFile), { recursive: true });
  await fs.writeFile(fieldFile, "field metadata");
  run.actionable = [
    {
      targetType: "field",
      objectApiName: "Lead",
      fieldApiName: "TestCheckbox__c"
    }
  ];
  run.diffs[0].summary = "Removed the field from the layout.";
  run.diffs[0].diff = "--- before\n+++ after\n-old\n+new\n";

  const result = await syncDiffsToWorkspace(run, {
    root: run.root,
    manifests: {
      packageXml: "<Package />",
      destructiveXml:
        "<Package><members>Lead.TestCheckbox__c</members></Package>"
    }
  });

  await assert.rejects(fs.access(fieldFile));
  assert.deepEqual(result.deleted, [
    "force-app/main/default/objects/Lead/fields/TestCheckbox__c.field-meta.xml"
  ]);
  assert.deepEqual(result.manifests, [
    "manifest/safeMetadataDelete/package.xml",
    "manifest/safeMetadataDelete/destructiveChangesPost.xml"
  ]);
  assert.equal(result.reviewArtifacts.length, 1);
  assert.match(
    await fs.readFile(path.join(run.root, result.reviewArtifacts[0]), "utf8"),
    /--- before/
  );
  assert.match(
    await fs.readFile(
      path.join(
        run.root,
        "manifest/safeMetadataDelete/destructiveChangesPost.xml"
      ),
      "utf8"
    ),
    /Lead\.TestCheckbox__c/
  );
});

test("removes the complete source directory for a deleted object", async (t) => {
  const run = await fixture();
  t.after(() => fs.rm(run.root, { recursive: true, force: true }));
  const objectDir = path.join(
    run.root,
    "force-app/main/default/objects/Safe_Account__c"
  );
  await fs.mkdir(path.join(objectDir, "listViews"), { recursive: true });
  await fs.writeFile(
    path.join(objectDir, "Safe_Account__c.object-meta.xml"),
    "object"
  );
  await fs.writeFile(
    path.join(objectDir, "listViews/All.listView-meta.xml"),
    "list view"
  );
  run.actionable = [
    {
      targetType: "object",
      objectApiName: "Safe_Account__c",
      fullName: "Safe_Account__c"
    }
  ];

  const result = await syncDiffsToWorkspace(run, {
    root: run.root,
    includeDiffs: false
  });

  await assert.rejects(fs.access(objectDir));
  assert.deepEqual(result.deleted.sort(), [
    "force-app/main/default/objects/Safe_Account__c/Safe_Account__c.object-meta.xml",
    "force-app/main/default/objects/Safe_Account__c/listViews/All.listView-meta.xml"
  ]);
});
