# agent-relay-experimental-plugin

> A home for [agent-relay](https://github.com/joniba/agent-relay) capabilities whose **final home has
> not been decided yet**, built as a normal drop-in plugin. Capabilities here are not necessarily
> related to each other.

"Experimental" refers to the *placement*, not the quality bar. A capability may be fully specified,
reviewed and relied upon while still living here because it has not been given a permanent repo.
Anything that graduates moves out — manually, with no automatic promotion path.

Internal working documents — requirements, design, plans — live in the private companion repo, not
here.

## Session roles

A **role** is a durable label naming which session currently answers to something like `code-owner`,
so callers stop having to know an alias that changes every restart.

```
assign_role(role, to?, force?)     designate a session
release_role(role, from?, force?)  give it up
send_to_role(role, content)        message whoever currently holds it
```

Roles also appear in `list_relay_agents`, so "who holds what" is answerable without another tool.

### How it works

A role is a fact a session publishes about **itself** on its own registry entry — one attribute per
role, keyed `role.<name>`, valued with the moment it was assigned. Nothing else stores anything, which
is what lets it work over any transport without knowing which one is installed: the registry is
already replicated by whatever is carrying the messages.

Everything follows from one rule: **a role is held by a live session.** Resolving one means scanning
live entries. A session that ends stops being live, so it stops holding its roles. One that dies
without warning goes stale, which amounts to the same thing. A resumed session keeps its roles
because it keeps its registry entry.

### Assigning

`assign_role` defaults to this session and needs nothing special. Two cases need `force`:

- targeting **another** session, and
- **displacing a live holder** — even when assigning to *yourself*, because taking the role off the
  previous holder is a write to *their* entry.

That gate is a convention, not a wall. It exists so the call that changes a running session's state
without telling it looks different at the call site from the one that doesn't.

### Requires

An agent-relay core with plugin **tools**, **activation** and **registry attributes**. Against an
older core the plugin fails to activate with a message saying exactly that, rather than misbehaving.

## Known gaps

Recorded deliberately rather than left to be discovered later. All three are accepted for now.

**A role does not survive starting a *new* session, and on the local transport it does not survive
quitting at all.** Persistence follows the registry entry. Resuming a session keeps its id, so it
keeps its entry and the roles on it; starting a *fresh* session gets a new id and holds nothing —
designate it again, which is one tool call. Whether the entry survives at all is a property of the
transport: the Postgres transport marks a departing session offline and keeps the entry, so roles come
back on resume, while the local SQLite transport **deletes** the entry on a graceful exit and the
roles go with it. Roles work on a local-only mesh while sessions are live; they just do not persist
across quitting. Making the local transport soft-delete instead was considered and rejected — it would
have leaked into presence semantics well beyond roles, since the alias-collision check and recipient
resolution both filter on heartbeat with no liveness predicate, so a soft-deleted entry would keep
reserving its alias and keep accepting messages after the session ended.

**A returning session can briefly advertise a role another session already holds.** Role conflicts
are resolved best-effort at session start: a session checks whether a role it still carries is
already held by a live session and, if so, releases it and warns. That check necessarily runs
*after* the session registers, so there is a short window in which both sessions advertise the same
role and a lookup could resolve to the wrong one. This is deliberately best-effort — closing it
entirely would require an atomic claim operation implemented by every transport, which is a cost the
capability does not justify.

**One holder per role, mesh-wide.** There is no way to scope a role to a machine, so two machines
cannot each have a `coordinator` — distinct names (`coordinator-desktop`, `coordinator-laptop`) are
the stopgap. Per-machine scoping needs the system to know which sessions share a machine, and nothing
currently can: core is deliberately machine-agnostic, `machine` is a convention of the Postgres
plugin, and the local transport reports nothing.

## Relationship to the other repos

| Repo | Role |
|---|---|
| [agent-relay](https://github.com/joniba/agent-relay) | Core — tools, seam contracts, plugin loader, local default transport |
| [agent-relay-pg-plugin](https://github.com/joniba/agent-relay-pg-plugin) | Cross-machine Postgres transport, Entra credentials, machine labelling |
| **this repo** | Experimental capabilities, composed alongside the above |

This plugin is designed to **compose with** the pg plugin rather than replace it, which constrains
what it may declare: `transport` is single-instance and last-loaded-wins, and plugins load
alphabetically, so a transport declared here would be silently overridden by the pg plugin. The same
applies to `renderPrompt`. Prefer the aggregate capabilities — `tools`, `briefing`, `interceptors` —
which every plugin contributes to.

## The plugin template

The first commit of this repo — **"Add the reusable agent-relay plugin template"** — is a standalone,
generic template. Start new plugin repos from that commit rather than copying an existing plugin and
deleting the parts you don't want. It carries the factory skeleton, plugin-owned `.env` loading, a
dependency-free test setup, the `files` install allowlist, and the contract notes below.

## What a plugin can and cannot do

A plugin default-exports a factory `(ctx) => Registration`. The Registration may declare any subset
of these capabilities:

| Capability | Shape | Composition |
|---|---|---|
| `tools` | `[{ name, description, parameters, handler }]` | **Aggregate** — appended to core's own |
| `briefing` | `"…text…"` | **Aggregate** — appended to the session briefing |
| `interceptors` | `[{ onSend?, onReceive?, renderPrompt? }]` | **Aggregate** — every plugin's, in load order |
| `activate` | `({ relay, self }) => {}` | Called once, after this session registers |
| `transport` | `{ id?, create(ctx) }` | Single-instance, **last-loaded wins** |
| `credentials` | `() => ({ get() {} })` | Single-instance, last-loaded wins |
| `identity` | `{ resolve(session) }` | Single-instance, last-loaded wins |

Things that surprise people:

- **Tools and briefing travel together.** A tool nobody can discover is a tool nobody calls. The tool
  list is a lookup surface for a human reading it, but for an LLM consumer the session **briefing** is
  the actual onboarding — a plugin contributing tools should contribute briefing text explaining when
  to reach for them.
- **A tool name cannot collide** with another plugin's tool or with a name core reserves for its own
  (`send_message`, `list_relay_agents`). A collision aborts the load rather than shadowing.
- **`activate` is the only point a plugin can act on the mesh it just joined.** The factory runs
  before the session has an identity; declared tools only run when a consumer calls them. `activate`
  receives the resolved identity and a live relay handle. A throw is contained: it disables that
  plugin's tools with a durable error rather than killing the session.
- **Two plugins that both declare a `transport` will fight**, and plugins load alphabetically, so the
  later name wins. If the goal is to shape messages rather than to own delivery, use an interceptor —
  `onSend` can rewrite a message (including its recipient) before whatever transport is installed
  receives it.
- **Loading is fail-loud and all-or-nothing.** Any import error, a missing factory, an invalid
  registration, or a registration declaring no usable capability aborts startup with an error naming
  the plugin, and the session runs with the relay **inactive**. There is no partial load.
- **To reject a message, drop it — don't throw.** Return from `onSend` / `onReceive` without calling
  `next`. A throw is treated as poison: it is logged and consumed, never redelivered.
- **`renderPrompt` is first-non-null-wins**, so only one plugin's ever runs. See
  [agent-relay#5](https://github.com/joniba/agent-relay/issues/5) — this plugin deliberately declares
  none rather than silently suppressing the pg plugin's machine label.
- **Never import agent-relay core.** Core is not a dependency. Duplicate the handful of helpers you
  need (see `stripControl` in `index.mjs`).

## Layout

```
index.mjs        the factory — default export, plus any helpers it needs
roles.mjs        the session-roles capability: tools, briefing, activation
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
