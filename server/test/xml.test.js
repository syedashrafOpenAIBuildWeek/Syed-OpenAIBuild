import test from "node:test";
import assert from "node:assert/strict";
import { destructiveManifests } from "../xml.js";
test("builds post-destructive manifest", () => {
  const result = destructiveManifests([
    { targetType: "field", objectApiName: "Account", fieldApiName: "Legacy__c" },
    { targetType: "object", objectApiName: "Old__c" },
  ]);
  assert.match(result.destructiveXml, /<members>Account.Legacy__c<\/members>/);
  assert.match(result.destructiveXml, /<members>Old__c<\/members>/);
  assert.doesNotMatch(result.packageXml, /<types>/);
});
