import assert from "node:assert/strict";
import { test } from "node:test";
import { discoveryReviewSchema, listingSchema } from "../src/domain.js";
import { contentHashOf, evaluateMatch, normalizeBatch, normalizeListing } from "../src/normalize.js";
import { discoveryFixturePages, matchingConfig } from "./helpers.js";

const observedAt = "2026-09-18T00:00:00.000Z";
const good = {externalId: "1001", title: "Business Analyst", company: "Northwind Example",
  url: "https://jobs.example.org/northwind/1001", locations: ["Melbourne, AU"]};

test("a well-formed raw listing normalizes to a stable, source-scoped identity", () => {
  const result = normalizeListing(good, "example", observedAt);
  assert.equal(result.outcome, "listing");
  if (result.outcome !== "listing") return;
  assert.ok(listingSchema.omit({firstSeenAt: true, lastSeenAt: true}).safeParse(result.listing).success);
  assert.equal(result.listing.id, "example:1001");
  assert.match(result.listing.contentHash, /^[a-f0-9]{64}$/);
});
test("content hash changes when visible content changes, and ignores location order", () => {
  const base = normalizeListing(good, "example", observedAt);
  const retitled = normalizeListing({...good, title: "Business Analyst II"}, "example", observedAt);
  const repaid = normalizeListing({...good, compensationText: "$70,000 - $85,000 AUD"}, "example", observedAt);
  const retyped = normalizeListing({...good, employmentType: "Full-time"}, "example", observedAt);
  assert.equal(base.outcome, "listing"); assert.equal(retitled.outcome, "listing");
  assert.equal(repaid.outcome, "listing"); assert.equal(retyped.outcome, "listing");
  if (base.outcome !== "listing" || retitled.outcome !== "listing" || repaid.outcome !== "listing" || retyped.outcome !== "listing") return;
  assert.notEqual(base.listing.contentHash, retitled.listing.contentHash);
  // Pay and employment type appearing (a "changed listing" in practice, e.g.
  // a provider adding a salary range on re-post) also changes the hash.
  assert.notEqual(base.listing.contentHash, repaid.listing.contentHash);
  assert.notEqual(base.listing.contentHash, retyped.listing.contentHash);
  const twoLocations = {title: good.title, company: good.company, canonicalUrl: base.listing.canonicalUrl, employmentType: null, compensationText: null};
  assert.equal(
    contentHashOf({...twoLocations, locations: ["Melbourne, AU", "Sydney, AU"]}),
    contentHashOf({...twoLocations, locations: ["Sydney, AU", "Melbourne, AU"]}),
  );
});

const malformedCases: Array<[string, unknown]> = [
  ["non-object payload", "not a listing"],
  ["missing external id", {...good, externalId: undefined}],
  ["unsafe external id characters", {...good, externalId: "abc def/ghi"}],
  ["missing title", {...good, title: undefined}],
  ["missing company", {...good, company: undefined}],
  ["missing url", {...good, url: undefined}],
  ["invalid url", {...good, url: "not-a-url"}],
  ["url with embedded credentials", {...good, url: "https://user:pass@jobs.example.org/1"}],
  ["empty locations", {...good, locations: []}],
];
for (const [label, raw] of malformedCases) {
  test(`malformed listing becomes a review item, never a thrown error: ${label}`, () => {
    const result = normalizeListing(raw, "example", observedAt);
    assert.equal(result.outcome, "review");
    if (result.outcome !== "review") return;
    assert.ok(discoveryReviewSchema.safeParse(result.review).success);
    assert.equal(result.review.sourceId, "example");
    assert.equal(result.review.observedAt, observedAt);
  });
}

test("employment type and pay are optional: absent on the raw listing, present and null on the normalized one", () => {
  const result = normalizeListing(good, "example", observedAt);
  assert.equal(result.outcome, "listing");
  if (result.outcome !== "listing") return;
  assert.equal(result.listing.employmentType, null);
  assert.equal(result.listing.compensationText, null);
});
test("employment type and pay are preserved verbatim (trimmed) when the raw listing provides them", () => {
  const result = normalizeListing({...good, employmentType: " Full-time ", compensationText: " $70,000 - $85,000 AUD "}, "example", observedAt);
  assert.equal(result.outcome, "listing");
  if (result.outcome !== "listing") return;
  assert.equal(result.listing.employmentType, "Full-time");
  assert.equal(result.listing.compensationText, "$70,000 - $85,000 AUD");
});

const strictMatching = {...matchingConfig, allowedEmploymentTypes: ["Full-time", "Part-time"], requireCompensation: true};

test("evaluateMatch: an employment type outside the allowed list disqualifies, even with a matching title", () => {
  const casual = normalizeListing({...good, employmentType: "Casual", compensationText: "$45/hour"}, "example", observedAt);
  assert.equal(casual.outcome, "listing");
  if (casual.outcome !== "listing") return;
  const decision = evaluateMatch(casual.listing, strictMatching);
  assert.equal(decision.decision, "not_a_match");
  assert.ok(decision.reasons.some((reason) => /Casual/.test(reason)));
});
test("evaluateMatch: an unknown employment type is a review item, not a guessed match", () => {
  const unknownType = normalizeListing({...good, compensationText: "$70,000 - $85,000 AUD"}, "example", observedAt);
  assert.equal(unknownType.outcome, "listing");
  if (unknownType.outcome !== "listing") return;
  assert.equal(unknownType.listing.employmentType, null);
  const decision = evaluateMatch(unknownType.listing, strictMatching);
  assert.equal(decision.decision, "needs_review");
  assert.deepEqual(decision.reasons, ["Employment type is unknown."]);
});
test("evaluateMatch: missing pay is a review item when compensation is required, not a guessed match", () => {
  const noPay = normalizeListing({...good, employmentType: "Full-time"}, "example", observedAt);
  assert.equal(noPay.outcome, "listing");
  if (noPay.outcome !== "listing") return;
  const decision = evaluateMatch(noPay.listing, strictMatching);
  assert.equal(decision.decision, "needs_review");
  assert.deepEqual(decision.reasons, ["Pay is unknown."]);
});
test("evaluateMatch: a clean match still requires neither disqualifying nor ambiguous signals", () => {
  const clean = normalizeListing({...good, employmentType: "Full-time", compensationText: "$70,000 - $85,000 AUD"}, "example", observedAt);
  assert.equal(clean.outcome, "listing");
  if (clean.outcome !== "listing") return;
  const decision = evaluateMatch(clean.listing, strictMatching);
  assert.equal(decision.decision, "match");
});
test("evaluateMatch: a permissive config (no employment-type restriction, pay not required) never reviews on those grounds", () => {
  const sparse = normalizeListing(good, "example", observedAt);
  assert.equal(sparse.outcome, "listing");
  if (sparse.outcome !== "listing") return;
  assert.equal(evaluateMatch(sparse.listing, matchingConfig).decision, "match");
});

test("duplicate external IDs within one batch collapse to one listing deterministically", () => {
  const [page] = discoveryFixturePages();
  const batch = normalizeBatch(page!.rawListings, "example", observedAt);
  assert.equal(batch.duplicatesInBatch, 1);
  const northwind1001 = batch.listings.find((listing) => listing.externalId === "1001");
  // Fixture order: "Business Analyst" then "Business Analyst II" for the same
  // external ID; the later occurrence wins, deterministically by fetch order.
  assert.equal(northwind1001?.title, "Business Analyst II");
  assert.equal(batch.reviews.length, 1);
  assert.equal(batch.reviews[0]?.reason, "Listing is missing a title.");
});

test("evaluateMatch: included keyword matches, excluded keyword wins over inclusion, and an unrecognized title needs review", () => {
  const analyst = normalizeListing(good, "example", observedAt);
  const engineer = normalizeListing({...good, externalId: "1003", title: "Software Engineer"}, "example", observedAt);
  const mixed = normalizeListing({...good, externalId: "1004", title: "Business Analyst / Software Engineer"}, "example", observedAt);
  const unknown = normalizeListing({...good, externalId: "1005", title: "Regional Manager"}, "example", observedAt);
  assert.equal(analyst.outcome, "listing"); assert.equal(engineer.outcome, "listing");
  assert.equal(mixed.outcome, "listing"); assert.equal(unknown.outcome, "listing");
  if (analyst.outcome !== "listing" || engineer.outcome !== "listing" || mixed.outcome !== "listing" || unknown.outcome !== "listing") return;

  const analystDecision = evaluateMatch(analyst.listing, matchingConfig);
  assert.equal(analystDecision.decision, "match");
  assert.equal(analystDecision.ruleVersion, matchingConfig.ruleVersion);
  assert.ok(analystDecision.reasons.length > 0);

  assert.equal(evaluateMatch(engineer.listing, matchingConfig).decision, "not_a_match");
  // A title naming both an included and an excluded keyword is not a guessed
  // match: exclusion wins, matching the repo's non-coding-role scope.
  assert.equal(evaluateMatch(mixed.listing, matchingConfig).decision, "not_a_match");
  assert.equal(evaluateMatch(unknown.listing, matchingConfig).decision, "needs_review");
});
