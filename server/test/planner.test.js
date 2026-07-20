import assert from "node:assert/strict";
import test from "node:test";
import {
  deterministicReferenceRemoval,
  flexiPageMetadataReferences,
  ownedObjectMetadata
} from "../planner.js";

test("detects a dynamic forms field instance in FlexiPage metadata", () => {
  const metadata = {
    flexiPageRegions: [
      {
        itemInstances: [
          {
            fieldInstance: {
              fieldItem: "Record.UpsellOpportunity__c"
            }
          }
        ]
      }
    ]
  };

  assert.equal(
    flexiPageMetadataReferences(metadata, "UpsellOpportunity__c"),
    true
  );
  assert.equal(flexiPageMetadataReferences(metadata, "Other__c"), false);
});

test("removes only the matching layout item on the deterministic fast path", () => {
  const content =
    "<Layout><layoutItems><field>Keep__c</field></layoutItems>" +
    "<layoutItems><field>Delete__c</field></layoutItems></Layout>";
  const result = deterministicReferenceRemoval(
    content,
    "main/default/layouts/Account.layout-meta.xml",
    ["Account.Delete__c"]
  );
  assert.ok(result);
  assert.match(result.updatedContent, /Keep__c/);
  assert.doesNotMatch(result.updatedContent, /Delete__c/);
});

test("discovers layouts and flexipages owned by a custom object", async () => {
  const query = async (soql) => {
    if (soql.includes("FROM Layout WHERE TableEnumOrId")) {
      return {
        records: [{ Id: "00h-layout", Name: "Safe Account Layout" }]
      };
    }
    if (soql.includes("FROM FlexiPage WHERE EntityDefinitionId")) {
      return {
        records: [
          {
            Id: "0M0-page",
            DeveloperName: "Safe_Account_Record_Page",
            MasterLabel: "Safe Account Record Page"
          }
        ]
      };
    }
    if (soql.includes("FROM Layout WHERE Id")) {
      return {
        records: [
          {
            Id: "00h-layout",
            FullName: "Safe_Account__c-Safe%20Account%20Layout"
          }
        ]
      };
    }
    throw new Error(`Unexpected query: ${soql}`);
  };

  const result = await ownedObjectMetadata("Safe_Account__c", query);

  assert.deepEqual(
    result.map(({ type, retrieveName, deleteWithTarget }) => ({
      type,
      retrieveName,
      deleteWithTarget
    })),
    [
      {
        type: "Layout",
        retrieveName: "Safe_Account__c-Safe Account Layout",
        deleteWithTarget: true
      },
      {
        type: "FlexiPage",
        retrieveName: "Safe_Account_Record_Page",
        deleteWithTarget: true
      }
    ]
  );
});
