import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPublicSample } from "./check-boundaries.mjs";

export function buildPublic(root) {
  checkPublicSample(root);
  const output = join(root, ".public");
  if (existsSync(output) && (lstatSync(output).isSymbolicLink() ||
      readdirSync(output).some((file) => !["index.html", "data.json"].includes(file)))) {
    throw new Error("Public output contains unexpected files. Build in a clean checkout.");
  }
  mkdirSync(output, {recursive: true});
  for (const file of ["index.html", "data.json"]) {
    const target = join(output, file);
    if (existsSync(target) && (lstatSync(target).isSymbolicLink() || lstatSync(target).nlink !== 1)) throw new Error("Unsafe public output path.");
    copyFileSync(join(root, "dashboard", file), target);
  }
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`Public sample built: ${buildPublic(resolve(fileURLToPath(new URL("..", import.meta.url))))}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
