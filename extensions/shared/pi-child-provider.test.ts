import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_PI_CHILD_PROVIDERS,
  isAllowedPiChildProvider,
} from "./pi-child-provider.ts";

test("Pi child sessions support configured Alibaba Cloud models", () => {
  assert.equal(isAllowedPiChildProvider("alibaba-cloud"), true);
  assert.equal(ALLOWED_PI_CHILD_PROVIDERS.includes("alibaba-cloud"), true);
});

test("Pi child sessions still reject arbitrary providers", () => {
  assert.equal(isAllowedPiChildProvider("untrusted-provider"), false);
});
