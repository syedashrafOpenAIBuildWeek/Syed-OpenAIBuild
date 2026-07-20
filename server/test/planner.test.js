import assert from "node:assert/strict";
import test from "node:test";
import {
  deterministicReferenceRemoval,
  flexiPageMetadataReferences
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
