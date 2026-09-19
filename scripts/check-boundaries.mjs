import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const allowedImports = new Set([
  "node:crypto", "node:fs", "node:fs/promises", "node:path", "node:url", "node:util", "node:sqlite",
  "node:readline/promises", "@notionhq/client", "zod",
]);
// The runtime may start exactly one subprocess: the read-only macOS Keychain
// lookup in src/credentials.ts. Anything else (a shell, claude, codex) is rejected.
const credentialFile = "src/credentials.ts";
const keychainBinary = "/usr/bin/security";
function isKeychainImport(node, filename) {
  const bindings = node.importClause?.namedBindings;
  return filename === credentialFile && ts.isImportDeclaration(node) && !node.importClause?.name && !node.importClause?.isTypeOnly &&
    bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length === 1 &&
    bindings.elements[0].name.text === "execFileSync" && !bindings.elements[0].propertyName;
}
// Notion SDK surfaces the write contract never uses: page creation or moves,
// content blocks, comments, database or data source changes, uploads, users.
const forbiddenSdkMembers = new Set(["blocks", "comments", "databases", "fileUploads", "users", "oauth", "views"]);
const forbiddenPageMembers = new Set(["create", "move", "properties"]);
const forbiddenDataSourceMembers = new Set(["create", "update"]);
export function checkRuntimeSource(source, filename) {
  const errors = [];
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) {
        const name = specifier.text;
        const approved = name.startsWith("./") || allowedImports.has(name) ||
          (name === "node:child_process" && isKeychainImport(node, filename));
        if (!approved) errors.push(`Unapproved runtime import in ${filename}`);
      }
    }
    if (ts.isIdentifier(node) && node.text === "execFileSync" && filename === credentialFile && !ts.isImportSpecifier(node.parent)) {
      const call = node.parent;
      const binary = ts.isCallExpression(call) && call.expression === node ? call.arguments[0] : undefined;
      if (!binary || !ts.isStringLiteral(binary) || binary.text !== keychainBinary) {
        errors.push(`Subprocess in ${filename} must call ${keychainBinary} directly`);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && ["require", "eval", "Function"].includes(callee.text))) {
        errors.push(`Dynamic execution or import in ${filename}`);
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const member = node.name.text;
      const owner = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
      if ((forbiddenSdkMembers.has(member) && /client$/i.test(node.expression.getText())) ||
        (owner === "pages" && forbiddenPageMembers.has(member)) || (owner === "dataSources" && forbiddenDataSourceMembers.has(member))) {
        errors.push(`Forbidden Notion SDK operation in ${filename}`);
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

// Writes are manual only. The unattended entry point may not reach any write
// module, directly or through another module. Files are keyed like "src/x.ts".
const writeModules = new Set(["src/writes.ts", "src/outbox.ts", "src/notion-writer.ts", "src/write-workflow.ts"]);
export function checkWriteIsolation(sources, entry = "src/scheduler.ts") {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    const ast = ts.createSourceFile(file, sources.get(file) ?? "", ts.ScriptTarget.Latest, true);
    for (const node of ast.statements) {
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier : undefined;
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith("./")) continue;
      const target = `src/${specifier.text.slice(2).replace(/\.js$/, ".ts")}`;
      if (writeModules.has(target)) return [`${entry} reaches write module ${target} through ${file}. Writes must stay manual.`];
      if (!seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
  return [];
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
  const ignored = ["profile/privacy-check", "pipeline/privacy-check", "prep/privacy-check", "targets/privacy-check", ".runtime/runs.sqlite", ".runtime/writes.sqlite", ".env", "dashboard/data.local.json"];
  for (const file of ignored) {
    try { execFileSync("git", ["check-ignore", "-q", file], {cwd: root}); }
    catch { errors.push(`Missing private ignore rule: ${file}`); }
  }
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (Object.keys(packageJson.dependencies ?? {}).some((name) => !["zod", "@notionhq/client"].includes(name))) {
    errors.push("Unreviewed production dependency. The runtime permits only the Notion SDK and Zod.");
  }
  const sources = new Map();
  function walk(path) {
    for (const entry of readdirSync(path, {withFileTypes: true})) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const source = readFileSync(full, "utf8");
        sources.set(relative(root, full), source);
        errors.push(...checkRuntimeSource(source, relative(root, full)));
      }
    }
  }
  walk(join(root, "src"));
  errors.push(...checkWriteIsolation(sources));
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
