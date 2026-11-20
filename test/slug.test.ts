import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, uniqueSlug, RESERVED_SLUGS } from "../src/slug.ts";

test("slugify makes lowercase letters, numbers and dashes", () => {
  assert.equal(slugify("Ana's Milk Tea · Counter 1"), "anas-milk-tea-counter-1");
  assert.equal(slugify("  Café  Ñino!! "), "cafe-nino");
  assert.equal(slugify("☕☕"), "");
});

test("slugify keeps slugs at most 40 characters and never ends on a dash", () => {
  const s = slugify("word ".repeat(30));
  assert.ok(s.length <= 40, s);
  assert.ok(!s.endsWith("-") && !s.startsWith("-"), s);
  assert.equal(slugify("x".repeat(80)).length, 40);
});

test("uniqueSlug adds a short suffix when the slug is taken", async () => {
  const taken = async (s: string) => s === "anas-milk-tea";
  assert.equal(await uniqueSlug("Ana's Milk Tea", taken, () => "k3x9"), "anas-milk-tea-k3x9");
  assert.equal(await uniqueSlug("Bea's Barber", taken, () => "k3x9"), "beas-barber");
});

test("uniqueSlug never returns an empty or reserved slug", async () => {
  const free = async () => false;
  assert.equal(await uniqueSlug("☕", free, () => "k3x9"), "queue-k3x9");
  assert.equal(await uniqueSlug("Login", free, () => "k3x9"), "login-k3x9");
  for (const r of ["app", "api", "admin", "q"]) assert.ok(RESERVED_SLUGS.has(r));
});

test("uniqueSlug keeps trying new suffixes until one is free", async () => {
  const used = new Set(["shop", "shop-aaaa"]);
  const suffixes = ["aaaa", "bbbb"];
  assert.equal(await uniqueSlug("Shop", async (s) => used.has(s), () => suffixes.shift()!), "shop-bbbb");
});
