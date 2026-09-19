import assert from "node:assert/strict";
import { test } from "node:test";
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, readKeychainToken } from "../src/credentials.js";

// The real Keychain is never touched: every case injects the security command.
test("the Keychain lookup uses a fixed, read-only argument list with no secret in it", () => {
  const token = "ntn_" + "K".repeat(40);
  let seen: readonly string[] = [];
  assert.equal(readKeychainToken((args) => { seen = args; return `${token}\n`; }), token);
  assert.deepEqual(seen, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]);
});
test("a missing item or locked keychain is an actionable AUTH error without provider details", () => {
  assert.throws(() => readKeychainToken(() => { throw new Error("security: SecKeychainSearchCopyNext: private-detail"); }),
    (error: Error & {code?: string}) => error.code === "AUTH" && /docs\/runtime\.md/.test(error.message) && !/private-detail/.test(error.message));
});
for (const output of ["", "\n", "two words\n", "tab\there"]) {
  test(`an empty or malformed Keychain value is rejected without echoing it: ${JSON.stringify(output)}`, () => {
    assert.throws(() => readKeychainToken(() => output), (error: Error & {code?: string}) =>
      error.code === "AUTH" && /value was not printed/.test(error.message) && (output.trim() === "" || !error.message.includes(output.trim())));
  });
}
