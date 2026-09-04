import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load this plugin's own gitignored `.env` into `process.env`.
 *
 * A plugin owns ALL of its configuration: core reads settings only from the
 * process environment and does NOT load any `.env` on a plugin's behalf. Keeping
 * config next to the plugin means its settings travel with the install instead of
 * having to be re-exported into every shell that launches a session.
 *
 * Dependency-free — uses Node's built-in `util.parseEnv`.
 *
 * **Precedence:** a variable ALREADY set in the real environment WINS — the file
 * only fills gaps — so any value can still be overridden ad-hoc from the shell.
 *
 * **Search order** (the FIRST existing file is loaded; the rest are ignored):
 *   1. `$AGENT_RELAY_ENV_FILE`  — explicit path (for non-standard install layouts)
 *   2. `<plugin-dir>/.env`      — next to this module (the recommended spot)
 *   3. `<plugin-dir>/../.env`   — one level up, for a cloned-layout install
 *
 * Call it at module scope in `index.mjs`, BEFORE the factory reads `ctx.env`.
 *
 * **Gotcha:** a value containing `#` MUST be double-quoted in the file, or
 * `parseEnv` treats the `#` as the start of a comment and truncates the value.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]  Target environment. Defaults to `process.env`.
 * @param {string} [opts.baseDir]  Directory to resolve the relative candidates
 *   from. Defaults to this module's directory (the plugin dir).
 * @returns {{ path: string, applied: string[] } | null}  The file that was loaded
 *   and the keys it actually set (gaps it filled), or `null` if no file was found.
 */
export function loadEnvFile({ env = process.env, baseDir } = {}) {
  const here = baseDir ?? dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.AGENT_RELAY_ENV_FILE,
    join(here, ".env"),
    resolve(here, "..", ".env"),
  ].filter(Boolean);

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let parsed;
    try {
      parsed = parseEnv(readFileSync(path, "utf8"));
    } catch {
      continue; // unparsable file — skip rather than crash the entry
    }
    const applied = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined) {
        env[key] = value;
        applied.push(key);
      }
    }
    return { path, applied };
  }
  return null;
}
