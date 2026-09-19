import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDiscovery } from "../src/discovery.js";
import { DiscoveryStore } from "../src/discoveryStore.js";
import type { JobSourceAdapter } from "../src/jobSource.js";
import { discoveryFixturePages, fixtureAdapter, matchingConfig } from "./helpers.js";

const temporary = () => mkdtempSync(join(tmpdir(), "job-hunt-discovery-run-"));
const failingAdapter = (sourceId: string): JobSourceAdapter => ({
  sourceId, fetchPage: async () => { throw new Error("simulated network outage"); },
});

test("one unavailable source cannot block or corrupt a healthy source's results", async () => {
  const store = new DiscoveryStore(temporary());
  try {
    const run = await runDiscovery({
      adapters: [fixtureAdapter("northwind", discoveryFixturePages()), failingAdapter("meridian")],
      store, matching: matchingConfig, observedAt: "2026-09-18T00:00:00.000Z",
    });

    const northwind = run.sources.find((source) => source.sourceId === "northwind");
    const meridian = run.sources.find((source) => source.sourceId === "meridian");
    assert.deepEqual(northwind, {sourceId: "northwind", ok: true, errorCode: null, fetched: 7, duplicatesInBatch: 1});
    assert.deepEqual(meridian, {sourceId: "meridian", ok: false, errorCode: "SOURCE", fetched: 0, duplicatesInBatch: 0});

    // 1001 (duplicate, last wins), 1003, 1004, 1005, 1006 normalize; 1002 (no title) is a review.
    assert.deepEqual(run.added.sort(), ["northwind:1001", "northwind:1003", "northwind:1004", "northwind:1005", "northwind:1006"]);
    assert.equal(run.reviews.length, 1);
    assert.equal(run.reviews[0]?.sourceId, "northwind");
    assert.equal(run.reviews[0]?.externalId, "1002");

    // The template matching config is permissive (no employment-type
    // restriction, pay not required), so 1004/1005/1006 match on title alone
    // here; src/normalize.test.ts exercises a stricter config that sends
    // an unlisted employment type or missing pay to review instead.
    const decisionFor = (id: string) => run.decisions.find((decision) => decision.listingId === id);
    assert.equal(decisionFor("northwind:1001")?.decision, "match");
    assert.equal(decisionFor("northwind:1003")?.decision, "not_a_match"); // "Software Engineer" title
    assert.equal(decisionFor("northwind:1004")?.decision, "match");
    assert.equal(decisionFor("northwind:1005")?.decision, "match");
    assert.equal(decisionFor("northwind:1006")?.decision, "match");
    for (const decision of run.decisions) assert.equal(decision.ruleVersion, matchingConfig.ruleVersion);

    assert.deepEqual(store.listListings().map((item) => item.id),
      ["northwind:1001", "northwind:1003", "northwind:1004", "northwind:1005", "northwind:1006"]);
    assert.equal(store.listReviews().length, 1);
  } finally { store.close(); }
});

test("a source going down on a later run does not erase what it discovered while healthy", async () => {
  const store = new DiscoveryStore(temporary());
  try {
    await runDiscovery({
      adapters: [fixtureAdapter("northwind", discoveryFixturePages())],
      store, matching: matchingConfig, observedAt: "2026-09-18T00:00:00.000Z",
    });
    const before = store.listListings().map((item) => item.id);
    assert.deepEqual(before, ["northwind:1001", "northwind:1003", "northwind:1004", "northwind:1005", "northwind:1006"]);

    const secondRun = await runDiscovery({
      adapters: [failingAdapter("northwind")],
      store, matching: matchingConfig, observedAt: "2026-09-19T00:00:00.000Z",
    });
    assert.equal(secondRun.sources[0]?.ok, false);
    assert.deepEqual(store.listListings().map((item) => item.id), before);
  } finally { store.close(); }
});
