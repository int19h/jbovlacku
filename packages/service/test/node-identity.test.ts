import assert from "node:assert/strict";
import test from "node:test";
import { trustedProxyAddresses } from "../../../apps/server/src/assistance.ts";

test("trusted proxy addresses accept spaces around comma-separated exact addresses", () => {
  assert.deepEqual(trustedProxyAddresses("127.0.0.1, 10.0.0.1 , ::1"), [
    "127.0.0.1",
    "10.0.0.1",
    "::1",
  ]);
  assert.deepEqual(trustedProxyAddresses(" , "), []);
  assert.throws(
    () => trustedProxyAddresses("127.0.0.1, 10.0.0.0/8"),
    /exact IP addresses/,
  );
  assert.throws(
    () => trustedProxyAddresses("127.0.0.1, localhost"),
    /exact IP addresses/,
  );
});
