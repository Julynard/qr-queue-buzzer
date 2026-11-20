import { test } from "node:test";
import assert from "node:assert/strict";
import { nextResetAfter, isValidResetTime, isValidTimeZone } from "../src/reset-time.ts";

test("midnight Manila is 16:00 UTC the same UTC day", () => {
  const now = Date.UTC(2026, 10, 20, 2, 0); // 10:00 Manila
  assert.equal(nextResetAfter(now, "00:00", "Asia/Manila"), Date.UTC(2026, 10, 20, 16, 0));
});

test("just before and exactly at the reset time", () => {
  const at = Date.UTC(2026, 10, 20, 16, 0);
  assert.equal(nextResetAfter(at - 1, "00:00", "Asia/Manila"), at);
  assert.equal(nextResetAfter(at, "00:00", "Asia/Manila"), at + 86400_000, "the next one is tomorrow");
});

test("a later time today in Manila", () => {
  const now = Date.UTC(2026, 10, 20, 2, 0); // 10:00 Manila
  assert.equal(nextResetAfter(now, "23:30", "Asia/Manila"), Date.UTC(2026, 10, 20, 15, 30));
});

test("month and year roll over", () => {
  const now = Date.UTC(2026, 11, 31, 17, 0); // 01:00 Jan 1 2027 in Manila
  assert.equal(nextResetAfter(now, "00:00", "Asia/Manila"), Date.UTC(2027, 0, 1, 16, 0));
});

test("time zones with daylight saving use the right offset", () => {
  // New York: EDT (UTC-4) until 2026-11-01, EST (UTC-5) after.
  const beforeSwitch = Date.UTC(2026, 9, 31, 12, 0);
  assert.equal(nextResetAfter(beforeSwitch, "00:00", "America/New_York"), Date.UTC(2026, 10, 1, 4, 0));
  const afterSwitch = Date.UTC(2026, 10, 2, 12, 0);
  assert.equal(nextResetAfter(afterSwitch, "00:00", "America/New_York"), Date.UTC(2026, 10, 3, 5, 0));
});

test("validation of settings values", () => {
  for (const ok of ["00:00", "05:30", "23:59"]) assert.ok(isValidResetTime(ok), ok);
  for (const bad of ["24:00", "5:30", "12:60", "", null, "noon"]) assert.ok(!isValidResetTime(bad), String(bad));
  assert.ok(isValidTimeZone("Asia/Manila"));
  assert.ok(!isValidTimeZone("Mars/Base"));
  assert.ok(!isValidTimeZone(""));
});
