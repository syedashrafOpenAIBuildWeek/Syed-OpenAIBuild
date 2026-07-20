import assert from "node:assert/strict";
import test from "node:test";
import { flexiPageMetadataReferences } from "../planner.js";

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
