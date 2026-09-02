#!/usr/bin/env node
// Reads pipeline/*.md (YAML frontmatter), writes dashboard/data.local.json.
// (data.local.json is gitignored — it holds real application data. The
// committed dashboard/data.json is sample-only, for the public demo deploy.)
// Run: node scripts/build-dashboard.mjs

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const pipelineDir = join(root, "pipeline");
const outFile = join(root, "dashboard", "data.local.json");

const STAGES = [
  "Researching",
  "Applied",
  "Screen",
  "Interview",
  "Final",
  "Offer",
  "Closed",
];

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w[\w_]*):\s*(.*)$/);
    if (!m) continue;
    let [, key, val] = m;
    val = val.trim().replace(/^["']|["']$/g, "");
    fm[key] = val;
  }
  return fm;
}

function loadApplications() {
  if (!existsSync(pipelineDir)) return [];
  return readdirSync(pipelineDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const raw = readFileSync(join(pipelineDir, f), "utf8");
      const fm = parseFrontmatter(raw);
      if (!fm) return null;
      return {
        id: f.replace(/\.md$/, ""),
        company: fm.company || f.replace(/\.md$/, ""),
        role: fm.role || "",
        stage: STAGES.includes(fm.stage) ? fm.stage : "Researching",
        applied_date: fm.applied_date || "",
        source_url: fm.source_url || "",
        contact: fm.contact || "",
        next_action: fm.next_action || "",
        next_action_date: fm.next_action_date || "",
      };
    })
    .filter(Boolean);
}

const applications = loadApplications();
writeFileSync(
  outFile,
  JSON.stringify({ stages: STAGES, applications, generated_at: new Date().toISOString() }, null, 2)
);
console.log(`Wrote ${applications.length} application(s) to ${outFile}`);
