import assert from "node:assert/strict";
import { test } from "node:test";
import { businessDate, digest, planMorning } from "../src/planner.js";
import { now, snapshot } from "./helpers.js";

test("daily plan is deterministic and independent of input ordering", () => {
  const input = snapshot();
  const original = structuredClone(input);
  const first = planMorning(input, now, "Australia/Melbourne");
  input.targets.reverse(); input.applications.reverse();
  assert.deepEqual(planMorning(input, now, "Australia/Melbourne"), first);
  assert.deepEqual(first.counts, {targets: 3, applications: 2, dueTargets: 2, followUps: 2, reviews: 0});
  assert.equal(original.targets[0]?.lastChecked, "2026-09-17");
  assert.equal(first.followUps[0]?.overdueDays, 1);
  assert.match(digest(first), /no sites scanned/);
});
for (const [frequency, lastChecked, expected] of [
  ["daily", null, 1], ["daily", "2026-09-17", 1], ["daily", "2026-09-18", 0],
  ["weekly", null, 1], ["weekly", "2026-09-10", 1], ["weekly", "2026-09-11", 0],
  ["weekly", "2026-09-12", 0], ["weekly", "2026-09-18", 0],
] as const) test(`${frequency}, last check ${lastChecked}: ${expected} due`, () => {
  const input = snapshot();
  input.targets = [{...input.targets[0]!, checkFrequency: frequency, lastChecked}];
  assert.equal(planMorning(input, now, "Australia/Melbourne").dueTargets.length, expected);
});
test("paused, rejected, future-dated and missing-URL targets are not scanned", () => {
  const target = snapshot().targets[0]!;
  const plan = planMorning({schemaVersion: 1, applications: [], targets: [
    {...target, id: "paused", watchStatus: "Paused"}, {...target, id: "rejected", watchStatus: "Not a fit"},
    {...target, id: "future", lastChecked: "2026-09-19"}, {...target, id: "missing", careersUrl: null},
  ]}, now, "Australia/Melbourne");
  assert.equal(plan.dueTargets.length, 0);
  assert.deepEqual(plan.reviews.map((item) => item.reason), ["future_last_checked", "missing_careers_url"]);
});
test("closed and future follow-ups are excluded; incomplete actions require review", () => {
  const application = snapshot().applications[0]!;
  const plan = planMorning({schemaVersion: 1, targets: [], applications: [
    {...application, id: "closed", stage: "Closed"}, {...application, id: "future", nextActionDate: "2026-09-19"},
    {...application, id: "undated", nextActionDate: null}, {...application, id: "no-action", nextAction: null},
  ]}, now, "Australia/Melbourne");
  assert.equal(plan.followUps.length, 0);
  assert.equal(plan.reviews.length, 2);
});
test("calendar dates use the configured timezone across midnight and DST", () => {
  assert.equal(businessDate(new Date("2026-09-17T14:05:00Z"), "Australia/Melbourne"), "2026-09-18");
  assert.equal(businessDate(new Date("2026-09-17T14:05:00Z"), "Asia/Bangkok"), "2026-09-17");
  assert.equal(businessDate(new Date("2026-10-04T13:05:00Z"), "Australia/Melbourne"), "2026-10-05");
  const input = snapshot();
  input.applications = [{...input.applications[0]!, nextActionDate: "2026-10-03"}];
  assert.equal(planMorning(input, new Date("2026-10-04T13:05:00Z"), "Australia/Melbourne").followUps[0]?.overdueDays, 2);
});
test("invalid inputs and invalid clocks fail before producing a plan", () => {
  const input = snapshot(); input.targets[0]!.lastChecked = "not-a-date";
  assert.throws(() => planMorning(input, now, "Australia/Melbourne"));
  assert.throws(() => businessDate(new Date("invalid"), "Australia/Melbourne"));
});
