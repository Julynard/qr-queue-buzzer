import { test } from "node:test";
import assert from "node:assert/strict";
import { safeNext } from "../src/html.ts";

const O = "https://aqona.app";

test("next keeps same-site paths", () => {
  assert.equal(safeNext("/app", O), "/app");
  assert.equal(safeNext("/q/anas-milk-tea/staff?x=1#top", O), "/q/anas-milk-tea/staff?x=1#top");
});

test("next never leaves the site", () => {
  for (const bad of ["//evil.com", "/%5Cevil.com", "/\\evil.com", "/%09/evil.com", "/\t/evil.com", "https://evil.com/app", "javascript:alert(1)", "evil.com", ""]) {
    assert.equal(safeNext(bad, O), "/app", bad);
  }
  assert.equal(safeNext(null, O), "/app");
});
