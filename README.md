# agent-relay-experimental-plugin

> A home for [agent-relay](https://github.com/joniba/agent-relay) capabilities whose **final home has
> not been decided yet**, built as a normal drop-in plugin. Capabilities here are not necessarily
> related to each other.

"Experimental" refers to the *placement*, not the quality bar. A capability may be fully specified,
reviewed and relied upon while still living here because it has not been given a permanent repo.
Anything that graduates moves out — manually, with no automatic promotion path.

Internal working documents — requirements, design, plans — live in the private companion repo, not
here.

## Known gaps

Recorded deliberately rather than left to be discovered later. Both are accepted for now.

**Roles do not survive quitting on the local transport.** A role is stored as an attribute on the
session's registry entry. The Postgres transport marks a departing session offline, so the entry and
its roles survive and a resumed session still holds them. The local SQLite transport **deletes** the
entry on a graceful exit, so the roles go with it and a resumed session starts with none. Roles work
on a local-only mesh while sessions are live; they just do not persist across quitting. Making the
local transport soft-delete instead was considered and rejected — it would have leaked into presence
semantics well beyond roles, since the alias-collision check and recipient resolution both filter on
heartbeat with no liveness predicate, so a soft-deleted entry would keep reserving its alias and keep
accepting messages after the session ended.

**A returning session can briefly advertise a role another session already holds.** Role conflicts
are resolved best-effort at session start: a session checks whether a role it still carries is
already held by a live session and, if so, releases it and warns. That check necessarily runs
*after* the session registers, so there is a short window in which both sessions advertise the same
role and a lookup could resolve to the wrong one. This is deliberately best-effort — closing it
entirely would require an atomic claim operation implemented by every transport, which is a cost the
capability does not justify.

## Relationship to the other repos

| Repo | Role |
|---|---|
| [agent-relay](https://github.com/joniba/agent-relay) | Core — tools, seam contracts, plugin loader, local default transport |
| [agent-relay-pg-plugin](https://github.com/joniba/agent-relay-pg-plugin) | Cross-machine Postgres transport, Entra credentials, machine labelling |
| **this repo** | Experimental capabilities, composed alongside the above |

This plugin is designed to **compose with** the pg plugin rather than replace it, which constrains
what it may declare: `transport` is single-instance and last-loaded-wins, and plugins load
alphabetically, so a transport declared here would be silently overridden by the pg plugin. Prefer
`interceptors` — an `onSend` hook can rewrite a message, including its recipient, before whichever
transport is installed receives it.

## The plugin template

The first commit of this repo — **"Add the reusable agent-relay plugin template"** — is a standalone,
generic template. Start new plugin repos from that commit rather than copying an existing plugin and
deleting the parts you don't want. It carries the factory skeleton, plugin-owned `.env` loading, a
dependency-free test setup, the `files` install allowlist, and the contract notes below.

## What a plugin can and cannot do

A plugin default-exports a factory `(ctx) => Registration`. The Registration may declare any subset
of **exactly four** capabilities:

| Capability | Shape | Composition |
|---|---|---|
| `interceptors` | `[{ onSend?, onReceive?, renderPrompt? }]` | **Aggregate** — every plugin's, in load order |
| `transport` | `{ id?, create(ctx) }` | Single-instance, **last-loaded wins** |
| `credentials` | `() => ({ get() {} })` | Single-instance, last-loaded wins |
| `identity` | `{ resolve(session) }` | Single-instance, last-loaded wins |

Things that surprise people:

- **A plugin cannot add or modify a tool.** `send_message` and `list_relay_agents` are defined in
  core. A plugin shapes what flows *through* them; it cannot introduce a new tool or change a tool's
  parameters.
- **Two plugins that both declare a `transport` will fight**, and plugins load alphabetically, so the
  later name wins. If the goal is to shape messages rather than to own delivery, use an interceptor —
  `onSend` can rewrite a message (including its recipient) before whatever transport is installed
  receives it.
- **Loading is fail-loud and all-or-nothing.** Any import error, a missing factory, an invalid
  registration, or a registration declaring no usable capability aborts startup with an error naming
  the plugin, and the session runs with the relay **inactive**. There is no partial load.
- **To reject a message, drop it — don't throw.** Return from `onSend` / `onReceive` without calling
  `next`. A throw is treated as poison: it is logged and consumed, never redelivered.
- **Never import agent-relay core.** Core is not a dependency. Duplicate the handful of helpers you
  need (see `stripControl` in `index.mjs`).

## Layout

```
index.mjs        the factory — default export, plus any helpers it needs
env-file.mjs     loads this plugin's own gitignored .env (a plugin owns its config)
tests/           node --test, no test framework dependency
package.json     name, agentRelay.entry, and the `files` install allowlist
```

`files` is the **install allowlist** — core copies exactly these paths into the installed plugin
folder. They must be literal file/directory paths, not npm globs. `tests/` and this README are
deliberately excluded from the install.

## Starting a new plugin from the template commit

1. Create the repo and copy in the template commit.
2. Rename in `package.json`: `name`, `description`, `keywords`, and add `repository`.
3. Rename the Registration's `name` in `index.mjs`.
4. Replace the pass-through interceptor with the real capabilities.
5. Extend `files` with any new directories the plugin needs at runtime.

## Configuration

A plugin owns all of its own configuration. Core reads settings only from the process environment and
never loads a `.env` for you. `loadEnvFile()` fills gaps in `process.env` from, in order:
`$AGENT_RELAY_ENV_FILE`, then `<plugin-dir>/.env`, then `<plugin-dir>/../.env`. Anything already
exported in the shell wins.

> **Gotcha:** double-quote any value containing `#`, or Node's `parseEnv` treats it as a comment and
> truncates the value.

## Install

Plugins have no installer of their own — agent-relay core installs them from a GitHub repo:

```bash
npx --yes github:joniba/agent-relay --add-plugin joniba/agent-relay-experimental-plugin
npx --yes github:joniba/agent-relay --remove-plugin agent-relay-experimental
```

Core clones the repo, runs `npm install --omit=dev`, and copies the `files` allowlist into the
extension's own `plugins/agent-relay-experimental/` folder, which survives core upgrades. A
gitignored `.env` in that folder is preserved across plugin upgrades.

Verify it loaded: look for `plugin loaded: agent-relay-experimental` in the rolling diagnostic log at
`<data-dir>/logs/agent-relay.log` (on Windows, `%LOCALAPPDATA%\agent-relay`).

## Test

```bash
npm test        # node --test, no dependencies
```

## License

MIT.
