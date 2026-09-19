import { z } from "zod";
import { readJson } from "./config.js";
import { text, validate } from "./domain.js";

// Private, machine-readable matching configuration for the current
// Business Analyst / Administration / Coordinator search. Lives at
// targets/matching.json (gitignored, see templates/matching-config.json),
// never at profile/ or pipeline/: matching reads only these keywords, never
// resume or accomplishment content.
export const matchingConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  // Bumping this invalidates no stored data (decisions are not persisted
  // keyed by rule version), but is recorded on every decision so a human
  // reviewing history can tell which rule produced it.
  ruleVersion: z.number().int().positive(),
  titleIncludeKeywords: z.array(text).min(1),
  titleExcludeKeywords: z.array(text),
});
export type MatchingConfig = z.infer<typeof matchingConfigSchema>;

export async function loadMatchingConfig(path: string): Promise<MatchingConfig> {
  return validate(matchingConfigSchema, await readJson(path), "Matching configuration");
}
