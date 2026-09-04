# agent-relay plugin template

> A minimal, working starting point for an [agent-relay](https://github.com/joniba/agent-relay)
> drop-in plugin — the one supported way to add capabilities to the relay from outside core.

This commit is the reusable template. Start a new plugin repo from it rather than copying an
existing plugin and deleting the parts you don't want.

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

## Starting a new plugin from this template

1. Create the repo and copy in this template commit.
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
npx --yes github:joniba/agent-relay --add-plugin <owner>/<repo>
npx --yes github:joniba/agent-relay --remove-plugin <package-name>
```

Core clones the repo, runs `npm install --omit=dev`, and copies the `files` allowlist into the
extension's own `plugins/<package-name>/` folder, which survives core upgrades. A gitignored `.env`
in that folder is preserved across plugin upgrades.

Verify it loaded: each plugin logs `plugin loaded: <name>` to the rolling diagnostic log at
`<data-dir>/logs/agent-relay.log` (on Windows, `%LOCALAPPDATA%\agent-relay`).

## Test

```bash
npm test        # node --test, no dependencies
```

## License

MIT.
