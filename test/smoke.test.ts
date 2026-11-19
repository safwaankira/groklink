import assert from "node:assert/strict";
import { test } from "node:test";
import { VERSION } from "../src/shared/version.ts";

test("VERSION is 0.1.4", () => {
  assert.equal(VERSION, "0.1.4");
});
