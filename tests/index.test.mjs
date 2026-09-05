import { test } from "node:test";
import assert from "node:assert/strict";

import createPlugin, { stripControl } from "../index.mjs";

test("the factory returns a Registration core will accept", () => {
  const reg = createPlugin({ env: {}, dataDir: null, log: () => {} });

  assert.equal(typeof reg, "object");
  assert.ok(reg !== null && !Array.isArray(reg), "registration must be a plain object");
  assert.equal(typeof reg.name, "string");
  // At least one usable capability, or core rejects the plugin at load time.
  assert.ok(Array.isArray(reg.tools) && reg.tools.length > 0);
});

test("the factory tolerates being called with no context at all", () => {
  const reg = createPlugin();
  assert.ok(Array.isArray(reg.tools) && reg.tools.length > 0);
});

test("every declared tool has the shape core validates", () => {
  const reg = createPlugin({ env: {} });
  for (const tool of reg.tools) {
    assert.equal(typeof tool.name, "string");
    assert.ok(tool.name.length > 0);
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.trim().length > 0, `${tool.name} needs a model-facing description`);
    assert.equal(typeof tool.parameters, "object");
    assert.equal(typeof tool.handler, "function");
  }
});

test("tools ship with briefing text naming them", () => {
  const reg = createPlugin({ env: {} });
  assert.equal(typeof reg.briefing, "string");
  assert.ok(reg.briefing.trim().length > 0);
  // The briefing is the actual onboarding for an LLM consumer; a tool absent from it
  // has to be discovered some other way.
  assert.match(reg.briefing, /send_to_role/);
});

test("activation is declared, since roles depend on knowing who this session is", () => {
  const reg = createPlugin({ env: {} });
  assert.equal(typeof reg.activate, "function");
});

test("stripControl removes framing characters from peer-controlled fields", () => {
  assert.equal(stripControl("alice\nX"), "aliceX");
  assert.equal(stripControl("a\u0000b\u2028c"), "abc");
  assert.equal(stripControl(null), "");
  assert.equal(stripControl(undefined), "");
});
