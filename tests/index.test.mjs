import { test } from "node:test";
import assert from "node:assert/strict";

import createPlugin, { stripControl } from "../index.mjs";

test("the factory returns a Registration core will accept", () => {
  const reg = createPlugin({ env: {}, dataDir: null, log: () => {} });

  assert.equal(typeof reg, "object");
  assert.ok(reg !== null && !Array.isArray(reg), "registration must be a plain object");
  assert.equal(typeof reg.name, "string");
  // At least one usable capability, or core rejects the plugin at load time.
  assert.ok(Array.isArray(reg.interceptors) && reg.interceptors.length > 0);
});

test("the factory tolerates being called with no context at all", () => {
  const reg = createPlugin();
  assert.ok(Array.isArray(reg.interceptors) && reg.interceptors.length > 0);
});

test("every declared interceptor exposes at least one lifecycle hook", () => {
  const reg = createPlugin({ env: {} });
  for (const [i, it] of reg.interceptors.entries()) {
    const usable =
      typeof it.onSend === "function" ||
      typeof it.onReceive === "function" ||
      typeof it.renderPrompt === "function";
    assert.ok(usable, `interceptor #${i} declares no onSend/onReceive/renderPrompt`);
  }
});

test("the template interceptor passes messages through unchanged", async () => {
  const [it] = createPlugin({ env: {} }).interceptors;
  const msg = { from: "alice", to: "bob", body: "hi", meta: { fromId: "s-alice" } };

  let passed;
  await it.onSend(msg, (m) => {
    passed = m;
    return m;
  });

  assert.equal(passed.body, "hi");
  assert.equal(passed.meta.fromId, "s-alice");
});

test("stripControl removes framing characters from peer-controlled fields", () => {
  assert.equal(stripControl("alice\nX"), "aliceX");
  assert.equal(stripControl("a\u0000b\u2028c"), "abc");
  assert.equal(stripControl(null), "");
  assert.equal(stripControl(undefined), "");
});
