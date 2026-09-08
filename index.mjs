import createRolesPlugin from "./roles.mjs";

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
 * into its seam registry. A Registration may declare any subset of these
 * capabilities, and nothing else:
 *
 * ```js
 * {
 *   tools:        [ { name, description, parameters, handler } ], // AGGREGATE — appended to core's own
 *   briefing:     "…text…",                                      // AGGREGATE — appended to the session briefing
 *   interceptors: [ { onSend?, onReceive?, renderPrompt? } ],     // AGGREGATE — every plugin's, in load order
 *   activate:     ({ relay, self }) => {},                        // once, after this session registers
 *   transport:    { id?, create(ctx) },                           // single-instance, LAST-loaded wins
 *   credentials:  () => ({ get() {} }),                           // single-instance, LAST-loaded wins
 *   identity:     { resolve(session) },                           // single-instance, LAST-loaded wins
 * }
 * ```
 *
 * Notes that are easy to get wrong:
 *
 * - **Tools and briefing travel together.** A tool nobody can discover is a tool
 *   nobody calls, and for an LLM consumer the briefing — not the tool list — is the
 *   actual onboarding. A tool name may not collide with another plugin's or with
 *   core's own; a collision aborts the load rather than shadowing.
 * - **`activate` is the only point a plugin can act on the mesh it just joined.**
 *   The factory runs before this session has an identity. A throw is contained: it
 *   disables that plugin's tools with a durable error rather than killing the session.
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
 *   `null` to defer; the FIRST non-null result wins, so only one plugin's prompt is
 *   ever used even though every renderer runs until one answers.
 * - **A plugin is named by core**, from its folder or entry filename. A `name` on the
 *   Registration is never read — do not rely on one.
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
  // Only `log` is taken. This plugin has no configuration of its own: a role is a
  // fact about a live session, held in the registry, so there is nothing to read from
  // the environment and no `.env` to load. The rest of `ctx` is deliberately ignored
  // rather than accepted and voided.
  const { log = () => {} } = ctx ?? {};

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
