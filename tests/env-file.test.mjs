import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEnvFile } from "../env-file.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "agent-relay-plugin-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("returns null when no .env exists anywhere", () => {
  withTempDir((dir) => {
    const env = {};
    assert.equal(loadEnvFile({ env, baseDir: dir }), null);
  });
});

test("fills gaps in the target environment from <plugin-dir>/.env", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, ".env"), "PLUGIN_SETTING=from-file\n");
    const env = {};
    const result = loadEnvFile({ env, baseDir: dir });

    assert.equal(env.PLUGIN_SETTING, "from-file");
    assert.deepEqual(result.applied, ["PLUGIN_SETTING"]);
  });
});

test("an already-set variable wins over the file", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, ".env"), "PLUGIN_SETTING=from-file\n");
    const env = { PLUGIN_SETTING: "from-shell" };
    const result = loadEnvFile({ env, baseDir: dir });

    assert.equal(env.PLUGIN_SETTING, "from-shell");
    assert.deepEqual(result.applied, [], "an existing value must not be reported as applied");
  });
});

test("AGENT_RELAY_ENV_FILE takes precedence over the plugin-dir file", () => {
  withTempDir((dir) => {
    const explicit = join(dir, "explicit.env");
    writeFileSync(explicit, "SOURCE=explicit\n");
    writeFileSync(join(dir, ".env"), "SOURCE=plugin-dir\n");

    const env = { AGENT_RELAY_ENV_FILE: explicit };
    loadEnvFile({ env, baseDir: dir });

    assert.equal(env.SOURCE, "explicit");
  });
});

test("a value containing # must be quoted to survive parsing", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, ".env"), 'QUOTED="user#EXT#@tenant"\nBARE=user#EXT#@tenant\n');
    const env = {};
    loadEnvFile({ env, baseDir: dir });

    assert.equal(env.QUOTED, "user#EXT#@tenant");
    assert.notEqual(env.BARE, "user#EXT#@tenant", "an unquoted # is treated as a comment");
  });
});
