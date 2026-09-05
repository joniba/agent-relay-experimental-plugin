import { loadEnvFile } from "./env-file.mjs";
import createRolesPlugin from "./roles.mjs";

// A plugin owns all of its own configuration. Load this plugin's gitignored
// `.env` into process.env at import time — BEFORE the factory below reads
// `ctx.env`. Shell-exported variables always win over the file.
loadEnvFile();

/**
 * Strip control characters from a peer-controlled string so it cannot forge line
 * breaks or framing in a rendered wake prompt.
 *
 * Deliberately a self-contained copy: a plugin MUST NOT import from agent-relay
 * core. Core is not a dependency — the installer git-clones this repo and copies
 * only the files in package.json's `files` allowlist.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function stripControl(s) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? "").replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, "");
}

/**
 * The plugin factory — an agent-relay plugin DEFAULT-exports one of these.
 *
 * Core calls it once at startup with `ctx` and folds the returned **Registration**
 * into its seam registry. A Registration may declare any subset of exactly four
 * capabilities, and nothing else:
 *
 * ```js
 * {
 *   interceptors: [ { onSend?, onReceive?, renderPrompt? } ], // AGGREGATE — every plugin's, in load order
 *   transport:    { id?, create(ctx) },                       // single-instance, LAST-loaded wins
 *   credentials:  () => ({ get() {} }),                       // single-instance, LAST-loaded wins
 *   identity:     { resolve(session) },                       // single-instance, LAST-loaded wins
 * }
 * ```
 *
 * Notes that are easy to get wrong:
 *
 * - **Tools cannot come from a plugin.** The `send_message` / `list_relay_agents`
 *   tool surface lives in core. A plugin extends behaviour through the four
 *   capabilities above; it cannot register a new tool or change a tool's schema.
 * - **`transport` is last-loaded-wins, and plugins load alphabetically.** If two
 *   installed plugins both declare a transport, only one survives. Prefer an
 *   interceptor when the goal is to shape messages rather than to own delivery.
 * - **Loading is fail-loud and all-or-nothing.** Throwing here, returning a
 *   non-object, or declaring no usable capability aborts startup with an error
 *   naming this plugin, and the session runs with the relay inactive.
 * - **An interceptor may mutate and must chain.** `onSend` / `onReceive` receive
 *   `(message, next)`; call `next(message)` to pass it on, or return WITHOUT
 *   calling `next` to DROP it. To reject a message, drop it — never throw, since a
 *   throw is treated as poison and consumed. `renderPrompt` returns a string, or
 *   `null` to defer to the default renderer.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   dataDir?: string|null,
 *   log?: (message: string, opts?: { level?: "warning"|"error" }) => void,
 * }} [ctx]
 *   `env` is the process environment (read your own config from it). `dataDir` is
 *   the per-user state directory for this plugin's own files, or null. `log`
 *   writes to the rolling diagnostic log. Identity is NOT resolved yet, so there
 *   is no `self` here.
 * @returns {object} a Registration
 */
export default function createPlugin(ctx) {
  const { env = process.env, dataDir = null, log = () => {} } = ctx ?? {};
  void env;
  void dataDir;

  const roles = createRolesPlugin();

  return {
    name: "agent-relay-experimental",
    tools: roles.tools,
    briefing: roles.briefing,
    // The relay handle and this session's identity only exist at activation, which
    // is why roles cannot be set up here: a role is a fact about *this* session, and
    // at factory time the session does not yet know who it is.
    activate: (activationCtx) => roles.activate({ ...activationCtx, log }),
  };
}
