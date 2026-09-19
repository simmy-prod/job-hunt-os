import { execFileSync } from "node:child_process";
import { AppError } from "./errors.js";

// Scheduled runs have no interactive shell, so the standalone Notion token lives
// in the user's login Keychain. These names are not secret; the value is.
export const KEYCHAIN_SERVICE = "job-hunt-os.notion";
export const KEYCHAIN_ACCOUNT = "NOTION_TOKEN";

export type SecurityCommand = (args: readonly string[]) => string;

// The only subprocess the runtime may start: a fixed, read-only Keychain lookup.
// No shell, empty environment, stderr discarded so nothing about the item is echoed.
const security: SecurityCommand = (args) => execFileSync("/usr/bin/security", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: {}, timeout: 10_000, maxBuffer: 64 * 1024,
});

export function readKeychainToken(run: SecurityCommand = security): string {
  let output: string;
  try {
    output = run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]);
  } catch {
    throw new AppError("AUTH", `Cannot read the Notion token from the macOS login Keychain (service ${KEYCHAIN_SERVICE}, account ${KEYCHAIN_ACCOUNT}). Add it as shown in docs/runtime.md, and make sure you are logged in so the keychain is unlocked.`);
  }
  const token = output.replace(/\r?\n$/, "");
  if (!token || /[\s\p{Cc}]/u.test(token)) {
    throw new AppError("AUTH", `The Keychain item ${KEYCHAIN_SERVICE} is empty or malformed. Re-add it as shown in docs/runtime.md; its value was not printed.`);
  }
  return token;
}
