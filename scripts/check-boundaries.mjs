import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const allowedImports = new Set([
  "node:crypto", "node:fs", "node:fs/promises", "node:path", "node:url", "node:util", "node:sqlite",
  "@notionhq/client", "zod",
]);
export function checkRuntimeSource(source, filename) {
  const errors = [];
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) {
        const name = specifier.text;
        if (!name.startsWith("./") && !allowedImports.has(name)) errors.push(`Unapproved runtime import in ${filename}`);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && ["require", "eval", "Function"].includes(callee.text))) {
        errors.push(`Dynamic execution or import in ${filename}`);
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      errors.push(`Dynamic execution in ${filename}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return errors;
}

export function checkPublicSample(root) {
  const sample = readFileSync(join(root, "dashboard/data.json"));
  const manifest = JSON.parse(readFileSync(join(root, "dashboard/sample-manifest.json"), "utf8"));
  if (createHash("sha256").update(sample).digest("hex") !== manifest.sha256) {
    throw new Error("Public sample changed. Verify that every record is fictional before updating sample-manifest.json.");
  }
  const data = JSON.parse(sample);
  for (const app of data.applications) {
    if (!["example.com", "example.org", "jobs.example.org"].includes(new URL(app.source_url).hostname)) {
      throw new Error("Public sample contains a non-example source URL.");
    }
  }
}

export function checkBoundaries(root) {
  const errors = [];
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {cwd: root, encoding: "utf8"}).split("\0").filter(Boolean);
  for (const file of files) {
    if (/^(profile|pipeline|prep|targets|\.runtime|\.public|node_modules|dist)\//.test(file) ||
      file === "dashboard/data.local.json" || /^\.env(?:\.|$)/.test(file)) errors.push(`Private or generated file in publishable set: ${file}`);
  }
  const ignored = ["profile/privacy-check", "pipeline/privacy-check", "prep/privacy-check", "targets/privacy-check", ".runtime/runs.sqlite", ".env", "dashboard/data.local.json"];
  for (const file of ignored) {
    try { execFileSync("git", ["check-ignore", "-q", file], {cwd: root}); }
    catch { errors.push(`Missing private ignore rule: ${file}`); }
  }
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (Object.keys(packageJson.dependencies ?? {}).some((name) => !["zod", "@notionhq/client"].includes(name))) {
    errors.push("Unreviewed production dependency. The runtime permits only the Notion SDK and Zod.");
  }
  function walk(path) {
    for (const entry of readdirSync(path, {withFileTypes: true})) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) errors.push(...checkRuntimeSource(readFileSync(full, "utf8"), relative(root, full)));
    }
  }
  walk(join(root, "src"));
  // Scan code/docs intended for publication, never the ignored private layer.
  for (const file of files.filter((name) => /\.(?:ts|mjs|json|md|yml)$/.test(name) && !/^\.claude\/worktrees\//.test(name))) {
    let content;
    try { content = readFileSync(join(root, file), "utf8"); } catch { continue; }
    if (/\b(?:sk-(?:proj-|ant-)[a-zA-Z0-9_-]{20,}|ntn_[a-zA-Z0-9]{25,}|secret_[a-zA-Z0-9]{25,})\b/.test(content)) {
      errors.push(`Possible credential in ${file}`);
    }
  }
  try { checkPublicSample(root); } catch (error) { errors.push(error.message); }
  if (errors.length) throw new Error(errors.join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { checkBoundaries(resolve(fileURLToPath(new URL("..", import.meta.url)))); console.log("Privacy and runtime dependency checks passed."); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
