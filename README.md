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
so callers can address *the job* rather than a particular session — no need to know which alias is
doing it today, or that the alias changes every restart. The role outlives the alias; it does not
outlive the session. See [Known gaps](#known-gaps) before relying on it across restarts.

```
assign_role(role, to?, force?)     designate a session
release_role(role, from?, force?)  give it up
send_to_role(role, content)        message whoever currently holds it
```

Roles also appear in `list_relay_agents`, so "who holds what" is answerable without another tool.

### How it works

A role is an attribute on a session's registry entry — one key per role, `role.<name>`, valued with
the moment it was assigned. Nothing else stores anything, which is what lets it work over any
transport without knowing which one is installed: the registry is already replicated by whatever is
carrying the messages.

Two consequences are worth stating separately, because only the first follows from the storage model:

**A role is held by a live session.** Resolving one scans the live roster, so a session that is not
running holds nothing. This is the rule the tools are built on.

"Live" means *recently heartbeating*, which lags reality by up to the staleness window. A session that
has stopped is still listed until it ages out, so for a short period a role can still resolve to it.
The message is delivered durably and waits — which is why `send_to_role` reports that it was sent
rather than that it was answered.

**Everything else about a role is best-effort.** Assignment is a read of the roster followed by
independent per-entry writes, with no atomic claim anywhere — no transport offers one. Uniqueness is
therefore a convention the tools maintain, not an invariant the system enforces, and the gaps below
are consequences of *that*, not of liveness.

### Assigning

```
assign_role({ role: "code-owner" })                        # this session takes it
assign_role({ role: "code-owner", to: "bob" })             # → refused, see below
assign_role({ role: "code-owner", to: "bob", force: true }) # hand it to bob
release_role({ role: "code-owner" })                       # give it up
send_to_role({ role: "code-owner", content: "please review #12" })
```

`to` and `from` take either the alias shown by `list_relay_agents` or a session id. An alias matching
more than one live session is refused rather than guessed.

`assign_role` defaults to this session and needs nothing special. `force` is required whenever the
operation writes an entry other than this session's — targeting someone else, or displacing a live
holder, which applies even when assigning to *yourself*.

The permission is decided for the whole operation before anything is written, so a refused assignment
changes nothing. A transport failure part-way is still possible; when it happens the role is left
unheld rather than doubly held, and the error says so, because an unheld role fails loudly on the next
`send_to_role` while a doubly held one would quietly route to one of them.

`force` is a convention, not a wall. It exists so the call that changes a running session's state
without telling it looks different at the call site from the one that doesn't.

### Requires

- **Node >= 22.5.0**, per `package.json`.
- **An agent-relay core with plugin tools, activation and registry attributes.** All three are recent;
  a core older than any of them cannot run this plugin.
- **A transport that stores attributes.** Attribute support is optional per transport, so a current
  core can still refuse the writes. The local SQLite transport and the Postgres plugin both support
  it; a third-party transport may not.

Activation is bounded by core at 15 seconds, and a timed-out activation is abandoned rather than
cancelled. The startup conflict check writes, so on a slow cross-machine mesh it can be declared
failed and still release the contested role a moment later. The release is the correct repair either
way; the only casualty is that the session was told activation failed when it partly succeeded.

**Check you have all three.** Start a session and look in the diagnostic log
(`<data-dir>/logs/agent-relay.log`) for both lines:

```
plugin loaded: agent-relay-experimental      ← tools capability present
plugin activated: agent-relay-experimental   ← activation capability present
```

If the first is missing, the core is too old for plugin tools. If the first appears without the
second, the core has tools but no activation hook, and the tools will say so when called. Attribute
support is the third, and it is a property of the *transport* rather than the core — a missing one
shows up as `assign_role` failing with "not supported by the active transport".

**Installing this plugin does not upgrade core** — `--add-plugin` deliberately leaves an existing
installation alone. Upgrade core first, then add the plugin, then start a **new** Copilot session;
extensions are loaded at session start, so an already-running session will not pick it up.

Against a core that has plugin tools but no activation hook, the tools load but never activate. They
say so — naming that possibility rather than telling you to retry something that cannot succeed.

## Known gaps

Recorded deliberately rather than left to be discovered later. All three are accepted for now.

**A role does not survive starting a *new* session, and on the local transport it does not survive
quitting at all.** Persistence follows the registry entry. Resuming a session keeps its id, so it
keeps its entry and the roles on it; starting a *fresh* session gets a new id and holds nothing —
designate it again, which is one tool call. Whether the entry survives at all is a property of the
transport: the Postgres transport marks a departing session offline and keeps the entry, so roles come
back on resume, while the local SQLite transport **deletes** the entry on a graceful exit and the
roles go with it. Roles work on a local-only mesh while sessions are live; they just do not persist
across quitting. Retaining the entry instead was considered and rejected, because an entry that
outlives its session is a presence question rather than a roles one — the reasoning is in the design
docs.

**Two sessions can end up holding the same role.** Assignment reads the roster and then writes
entries independently; there is no atomic claim, because no transport offers one. Two sessions
assigning themselves the same role concurrently will both succeed, and a returning session briefly
advertises a role it held before the startup check has run. Uniqueness is therefore **convergent**
rather than enforced:

- `assign_role` displaces *every* live holder, so any assignment settles the role.
- At startup a session releases a role that a live session has claimed **more recently** than it did,
  and warns — in the diagnostic log (`<data-dir>/logs/agent-relay.log`; on Windows
  `%LOCALAPPDATA%\agent-relay`), not in the session. Nothing tells you in-session that a role was
  dropped, so if you are relying on one after a restart, check that you still hold it. Comparing claim
  times rather than mere presence is what stops two returning sessions from each yielding and leaving
  the role held by nobody. Two claims sharing an identical timestamp — two sessions assigning in the
  same millisecond — leave neither strictly newer, so neither yields and the duplicate persists until
  the next assignment. That is the safe direction, but it does mean the tie-break is by claim time
  rather than a total order.
- While a role is contested, `send_to_role` delivers to the most recent claim and says the role is
  contested rather than picking silently — including when the most recent claim is **you**, in which
  case it refuses and says how many others also hold it.

**Contestation surfaces when you send, not when you list.** `list_relay_agents` renders roles
generically — core groups `role.*` keys without knowing what they mean, so it cannot flag that two
sessions sharing one is a problem, and this plugin does not render the roster. A contested role
therefore looks like two ordinary rows. `send_to_role` is the surface that tells you.

**One holder per role, mesh-wide.** There is no way to scope a role to a machine, so two machines
cannot each have a `coordinator` — distinct names (`coordinator-desktop`, `coordinator-laptop`) are
the stopgap. The information is not really the obstacle: the Postgres transport does publish a
`machine` for each session. But `machine` is that transport's convention, not something core knows,
and scoping on it would make a transport-agnostic capability depend on one transport being installed —
which is the coupling this design exists to avoid. Machine scoping needs a transport-neutral notion of
locality first.

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
- **Two plugins that both declare a `transport` will fight**, so only one survives. Installed plugins
  load alphabetically by folder; anything listed in `AGENT_RELAY_PLUGINS` loads first, in the order
  listed. If the goal is to shape messages rather than to own delivery, use an interceptor — `onSend`
  can rewrite a message (including its recipient) before whatever transport is installed receives it.
- **Loading is fail-loud and all-or-nothing.** Any import error, a missing factory, an invalid
  registration, or a registration declaring no usable capability aborts startup with an error naming
  the plugin, and the session runs with the relay **inactive**. There is no partial load.
- **To reject a message, drop it — don't throw.** Return from `onSend` / `onReceive` without calling
  `next`. A throw is treated as poison: it is logged and consumed, never redelivered.
- **`renderPrompt` is first-non-null-wins.** Every renderer runs until one answers, and only that
  one result is used. See [agent-relay#5](https://github.com/joniba/agent-relay/issues/5) — this
  plugin deliberately declares none rather than silently suppressing the pg plugin's machine label.
- **A plugin is named by core**, from its installed folder or entry filename. A `name` on the
  Registration is never read.
- **Never import agent-relay core.** Core is not a dependency. Duplicate the handful of helpers you
  need (see `stripControl` in `index.mjs`).

## Layout

```
index.mjs        the factory — default export, plus any helpers it needs
roles.mjs        the session-roles capability: tools, briefing, activation
tests/           node --test, no test framework dependency
package.json     name, agentRelay.entry, and the `files` install allowlist
```

`files` is the **install allowlist** — core copies exactly these paths into the installed plugin
folder. They must be literal file/directory paths, not npm globs. `tests/` and this README are
deliberately excluded from the install.

## Starting a new plugin from the template commit

1. Create the repo and copy in the template commit.
2. Rename in `package.json`: `name`, `description`, `keywords`, and add `repository`.
3. Replace the pass-through interceptor with the real capabilities.
4. Extend `files` with any new directories the plugin needs at runtime.

> The template commit is frozen, so its contract notes describe core as it was when the commit was
> made — it predates plugin `tools`, `briefing` and `activate`, for instance, which is why its
> skeleton registers a do-nothing interceptor: back then that was the smallest thing core would
> accept. It no longer is. Take the skeleton from the commit and the contract from the section above,
> which tracks the core this repo is built against.

## Configuration

This plugin has none. A role is a fact about a live session, held in the registry, so there is
nothing to read from the environment and no `.env` to load — the factory takes only the diagnostic
logger and ignores the rest of its context.

A plugin that *does* need configuration owns all of it: core reads settings only from the process
environment and never loads a `.env` on a plugin's behalf. See the pg plugin for that pattern.

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
