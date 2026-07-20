import assert from "node:assert/strict";
import test from "node:test";
import { parseLiteralIntent } from "../openai.js";

test("parses an explicit field deletion without an API call", () => {
  assert.deepEqual(parseLiteralIntent("Delete Legacy_Field__c from Account"), {
    action: "delete",
    targetType: "field",
    objectApiName: "Account",
    fieldApiNames: ["Legacy_Field__c"]
  });
});

test("parses an explicit object deletion without an API call", () => {
  assert.deepEqual(parseLiteralIntent("Delete custom object Legacy__c"), {
    action: "delete",
    targetType: "object",
    objectApiName: "Legacy__c",
    fieldApiNames: []
  });
});

test("leaves natural-language and ambiguous commands for the model", () => {
  assert.equal(parseLiteralIntent("Please remove the old field"), null);
  assert.equal(parseLiteralIntent("Delete A__c and B__c from Account"), null);
});
