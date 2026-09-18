import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configSchema, notionConfigSchema } from "../src/config.js";
import { snapshotSchema } from "../src/domain.js";

export const root = fileURLToPath(new URL("../..", import.meta.url));
export const config = configSchema.parse(JSON.parse(readFileSync(`${root}/templates/runtime-config.json`, "utf8")));
export const notionConfig = notionConfigSchema.parse(config.source);
export const now = new Date("2026-09-18T00:00:00Z");
export function snapshot() {
  return snapshotSchema.parse(JSON.parse(readFileSync(`${root}/tests/fixtures/snapshot.json`, "utf8")));
}
export function metadata() {
  const properties = {
    Company: {type: "title"}, "Watch Status": {type: "select"}, "Careers URL": {type: "url"},
    "Role Type": {type: "multi_select"}, "Last Checked": {type: "date"}, "Pipeline Stage": {type: "select"},
    "Next Action": {type: "rich_text"}, "Next Action Date": {type: "date"}, "Check Frequency": {type: "select"},
  };
  return {properties};
}
export function page(id = "22222222-2222-4222-8222-222222222222") {
  return {
    object: "page", id, in_trash: false,
    properties: {
      Company: {type: "title", title: [{plain_text: "Example Studio"}]},
      "Watch Status": {type: "select", select: {name: "Active watch"}},
      "Careers URL": {type: "url", url: "https://jobs.example.org/example"},
      "Role Type": {type: "multi_select", multi_select: [{name: "IT Desk"}]},
      "Last Checked": {type: "date", date: null},
      "Pipeline Stage": {type: "select", select: {name: "Researching"}},
      "Next Action": {type: "rich_text", rich_text: [{plain_text: "Review requirements"}]},
      "Next Action Date": {type: "date", date: {start: "2026-09-18", end: null}},
      "Check Frequency": {type: "select", select: null},
    },
  };
}
export function batch(results: unknown[]) { return {results, has_more: false, next_cursor: null}; }
