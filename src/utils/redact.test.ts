import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "./redact.js";

test("redactSecrets removes common secret patterns and long entropy blobs", () => {
  const input = [
    "ANTHROPIC_API_KEY=sk-ant-api03-supersecretvalue1234567890",
    "gh token: ghp_abcd1234efgh5678ijkl9012mnop3456qrst7890",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.payload",
    "blob: QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODkwQUJDREVGR0hJSktMTU5PUFFSU1RVVg==",
  ].join("\n");

  const output = redactSecrets(input);

  assert.doesNotMatch(output, /sk-ant-api03-supersecret/i);
  assert.doesNotMatch(output, /ghp_abcd1234/i);
  assert.doesNotMatch(output, /Bearer\s+eyJ/i);
  assert.match(output, /\[REDACTED\]/);
});
