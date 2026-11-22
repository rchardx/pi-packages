import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  DEEPSEEK_API_ORIGIN,
  EXA_API_ORIGIN,
  resolveDeepSeekHeaders,
  resolveExaHeaders,
} from "../src/auth.ts";

function preserveEnv(t: TestContext, name: "DEEPSEEK_API_KEY" | "EXA_API_KEY") {
  const previous = process.env[name];
  delete process.env[name];
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("hardcoded provider origins point exclusively to the official APIs", () => {
  assert.equal(DEEPSEEK_API_ORIGIN, "https://api.deepseek.com");
  assert.equal(EXA_API_ORIGIN, "https://api.exa.ai");
});

test("resolveDeepSeekHeaders reads DEEPSEEK_API_KEY, trims outer whitespace, and sanitizes invalid values", (t) => {
  preserveEnv(t, "DEEPSEEK_API_KEY");
  assert.throws(() => resolveDeepSeekHeaders(), /Configure DEEPSEEK_API_KEY/u);

  process.env.DEEPSEEK_API_KEY = "   ";
  assert.throws(() => resolveDeepSeekHeaders(), /Configure DEEPSEEK_API_KEY/u);

  process.env.DEEPSEEK_API_KEY = "  deepseek-test-key  ";
  assert.deepEqual(Object.fromEntries(resolveDeepSeekHeaders()), {
    authorization: "Bearer deepseek-test-key",
  });

  process.env.DEEPSEEK_API_KEY = "bad-secret\r\nx-injected: 1";
  assert.throws(
    () => resolveDeepSeekHeaders(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "Invalid DEEPSEEK_API_KEY header value; check the environment variable.",
      );
      assert.ok(!error.message.includes("bad-secret"));
      return true;
    },
  );
});

test("resolveExaHeaders reads EXA_API_KEY, trims outer whitespace, and sanitizes invalid values", (t) => {
  preserveEnv(t, "EXA_API_KEY");
  assert.throws(() => resolveExaHeaders(), /Configure EXA_API_KEY/u);

  process.env.EXA_API_KEY = "\t\n";
  assert.throws(() => resolveExaHeaders(), /Configure EXA_API_KEY/u);

  process.env.EXA_API_KEY = "  exa-test-key  ";
  assert.deepEqual(Object.fromEntries(resolveExaHeaders()), {
    "x-api-key": "exa-test-key",
  });

  process.env.EXA_API_KEY = "exa-secret-密钥";
  assert.throws(
    () => resolveExaHeaders(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "Invalid EXA_API_KEY header value; check the environment variable.",
      );
      assert.ok(!error.message.includes("exa-secret"));
      return true;
    },
  );
});
