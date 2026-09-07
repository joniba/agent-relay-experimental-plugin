/**
 * Session roles — the durable label naming which session currently answers to
 * something like `code-owner`, so callers stop having to know an alias that changes
 * every restart.
 *
 * A role is a fact a session publishes about **itself** on its own registry entry:
 * one attribute per role, keyed `role.<name>`, valued with the moment it was
 * assigned. Nothing else stores anything. That is what lets this work over any
 * transport without knowing which one is installed — the registry is already
 * replicated by whatever is carrying messages.
 *
 * Everything else follows from one rule: **a role is held by a live session.**
 *  - resolving a role means scanning live entries for the key;
 *  - a session that ends gracefully stops being live, so it stops holding its roles;
 *  - a session that dies without warning goes stale, which is the same thing;
 *  - a resumed session keeps its roles because it keeps its registry entry — on
 *    transports that keep the entry. See KNOWN GAPS in the README.
 */

const ROLE_PREFIX = "role.";

/**
 * Free-form, but bounded. The slug keeps role names readable in the roster and
 * unambiguous as attribute keys — `role.` + this can never collide with another
 * namespace or need escaping.
 */
const ROLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Normalise a caller-supplied role, or explain why it isn't one. */
function normalizeRole(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { error: "'role' is required" };
  }
  const role = raw.trim().toLowerCase();
  if (!ROLE_PATTERN.test(role)) {
    return {
      error:
        `"${raw}" is not a valid role name. Use lower-case letters, digits, hyphen or ` +
        `underscore, starting with a letter or digit, up to 64 characters.`,
    };
  }
  return { role };
}

const failure = (textResultForLlm) => ({ textResultForLlm, resultType: "failure" });
const success = (textResultForLlm) => ({ textResultForLlm, resultType: "success" });

/** Names as `"a" and "b"` — these strings are read by a model, so they read as prose. */
const list = (names) => names.map((n) => `"${n}"`).join(" and ");

/** Every role an agent entry currently publishes. */
function rolesOf(agent) {
  const attributes = (agent && agent.attributes) || {};
  return Object.keys(attributes)
    .filter((k) => k.startsWith(ROLE_PREFIX) && k.length > ROLE_PREFIX.length)
    .map((k) => k.slice(ROLE_PREFIX.length));
}

/** When an agent claimed a role — the attribute's value — or "" if it does not hold it. */
function claimedAt(agent, role) {
  return String(((agent && agent.attributes) || {})[ROLE_PREFIX + role] ?? "");
}

/**
 * Every live session publishing a role, newest claim first.
 *
 * Plural on purpose. Nothing enforces one-holder-per-role at write time — two sessions
 * can each assign the role to themselves, and neither write touches the other's entry,
 * so neither is refused. Reading only the first match would silently route to an
 * arbitrary one of them; reading them all lets an assignment clean the duplicates up.
 *
 * The attribute value is the assignment time, so the newest claim sorts first and
 * resolution is at least deterministic and defensible while duplicates exist.
 */
function holdersOf(agents, role) {
  return agents
    .filter((a) => rolesOf(a).includes(role))
    .sort((x, y) => claimedAt(y, role).localeCompare(claimedAt(x, role)));
}

/** Resolve a caller-supplied target — a name or a session id — against the roster. */
function resolveTarget(agents, wanted, self) {
  // Default to this session, but look it UP in the roster: a synthesised entry would
  // have no attributes, so every role it already holds would look absent.
  if (!wanted) {
    return { agent: agents.find((a) => a.id === self.id) ?? { id: self.id, name: self.name } };
  }
  const byId = agents.find((a) => a.id === wanted);
  if (byId) return { agent: byId };
  const named = agents.filter((a) => a.name === wanted);
  if (named.length === 1) return { agent: named[0] };
  if (named.length > 1) {
    return { error: `"${wanted}" matches ${named.length} live sessions — use a session id instead.` };
  }
  return { error: `no live session called "${wanted}"` };
}

export default function createRolesPlugin() {
  // Captured at activation. Until then the plugin has no identity and no way to
  // reach the mesh, so its tools have to say so rather than throw.
  let relay = null;
  let self = null;
  let unavailable = null;

  /** Guard every tool: the relay may not exist yet, or may not support attributes. */
  function notReady() {
    if (unavailable) return failure(unavailable);
    if (!relay || !self) {
      // Deliberately names the permanent possibility rather than asserting the
      // transient one. A core with plugin *tools* but no activation hook never calls
      // `activate`, so this state never resolves — and telling that caller to retry
      // would be advice that can only ever fail.
      return failure(
        "The roles plugin has not activated. Either agent-relay is still starting up — " +
          "in which case try again in a moment — or this core does not support plugin " +
          "activation, which the roles plugin requires. If retrying does not help, " +
          "update agent-relay.",
      );
    }
    return null;
  }

  /**
   * Apply one role write. Returns null on success, or a failure result.
   *
   * `force` is threaded through rather than supplied silently: writing another
   * session's entry changes the state of something that is running and will not be
   * told, so the caller has to ask for it. Note this bites even when *assigning to
   * yourself*, because displacing the previous holder is a write to their entry.
   */
  async function write(id, role, value, force) {
    const res = await relay.setAttributes({
      id,
      attributes: { [ROLE_PREFIX + role]: value },
      force,
    });
    if (!res || !res.ok) {
      return failure(`Could not update roles: ${(res && res.error) || "unknown error"}`);
    }
    return null;
  }

  return {
    name: "agent-relay-roles",

    briefing:
      "Sessions can hold named roles — a stable handle for whoever is currently doing a job, " +
      "rather than for one specific session. Prefer send_to_role over send_message when you " +
      "mean 'whoever currently holds this job'; list_relay_agents shows who holds what. A role " +
      "is held by a live session, so if nobody holds the one you need, use assign_role to " +
      "designate one — including after a restart.",

    /**
     * The conflict repair, run once at startup.
     *
     * A resumed session keeps its registry entry, and therefore the roles on it — but
     * someone may have been given one of them meanwhile. The returning session yields
     * rather than silently taking it back, because a restart is not a decision about
     * who should hold a role, whereas the assignment that happened in between was.
     *
     * Deliberately best-effort: it runs after this session registers, so there is a
     * brief window where both advertise the role. Closing that would need an atomic
     * claim in every transport, which is a cost the capability does not justify.
     */
    async activate(ctx) {
      self = ctx.self;
      relay = ctx.relay;

      if (typeof relay.setAttributes !== "function") {
        unavailable =
          "The roles plugin needs a newer agent-relay core: this one has no setAttributes. " +
          "Update agent-relay, or remove this plugin.";
        relay = null;
        throw new Error(unavailable);
      }

      const agents = await relay.listAgents();
      const mine = agents.find((a) => a.id === self.id);
      if (!mine) return;

      for (const role of rolesOf(mine)) {
        // Yield only to a *newer* claim. The check is otherwise symmetric, and two
        // sessions returning together would then each see the other holding the role
        // and each release it, leaving it held by nobody. Comparing claim times gives
        // both sides the same answer, and it is the same rule the rest of the plugin
        // uses: the most recent assignment was the most recent decision.
        const mineAt = claimedAt(mine, role);
        const holder = agents.find((a) => a.id !== self.id && claimedAt(a, role) > mineAt);
        if (!holder) continue;
        // Addressed explicitly rather than relying on the seam's default, so the
        // write is unambiguous at the call site.
        const res = await relay.setAttributes({
          id: self.id,
          attributes: { [ROLE_PREFIX + role]: null },
        });
        // Reporting a release that did not happen would be worse than not reporting
        // one: it leaves two sessions advertising the role with the only diagnostic
        // saying otherwise. `setAttributes` reports a transport that cannot store
        // attributes by returning, not by throwing, so the result has to be read.
        if (res && res.ok) {
          ctx.log?.(`roles: released "${role}" — ${holder.name} holds it now`, {
            level: "warning",
          });
        } else {
          ctx.log?.(
            `roles: still advertising "${role}", which ${holder.name} also holds — ` +
              `could not release it: ${(res && res.error) || "unknown error"}`,
            { level: "warning" },
          );
        }
      }
    },

    tools: [
      {
        name: "assign_role",
        description:
          "Designate a session as the holder of a role. Defaults to this session. If another " +
          "live session already holds the role it is transferred, which writes to that " +
          "session's entry and therefore needs force.",
        parameters: {
          type: "object",
          properties: {
            role: { type: "string", description: "Role name, e.g. code-owner" },
            to: {
              type: "string",
              description:
                "Target session: either the alias shown by list_relay_agents, or a session id. " +
                "Defaults to this session. An alias matching more than one live session is refused " +
                "rather than guessed — use an id.",
            },
            force: {
              type: "boolean",
              description:
                "Required to write a session other than this one — including displacing the " +
                "current holder. Use only with human approval.",
            },
          },
          required: ["role"],
        },
        handler: async ({ role: rawRole, to, force = false } = {}) => {
          const guard = notReady();
          if (guard) return guard;
          const { role, error } = normalizeRole(rawRole);
          if (error) return failure(error);

          const agents = await relay.listAgents();
          const target = resolveTarget(agents, to, self);
          if (target.error) return failure(target.error);

          const holders = holdersOf(agents, role);
          if (holders.length === 1 && holders[0].id === target.agent.id) {
            return success(`"${target.agent.name}" already holds "${role}".`);
          }

          // Decide permission for the WHOLE operation before mutating anything.
          //
          // The transport judges each write on its own, so leaving the gate to it lets
          // a hand-off half-happen: when this session is the incumbent, stripping the
          // role from itself is allowed without force, and only the write to the new
          // holder is refused. The caller is told "refused" while the role has in fact
          // been taken from its holder and given to nobody.
          const strangers = holders
            .filter((h) => h.id !== self.id && h.id !== target.agent.id)
            .map((h) => h.name);
          if (target.agent.id !== self.id) strangers.push(target.agent.name);
          if (strangers.length && !force) {
            return failure(
              `Assigning "${role}" this way writes ${strangers.map((n) => `"${n}"`).join(" and ")}, ` +
                `not just this session. Pass force: true if that is intended.`,
            );
          }

          // Release before assigning, so a transport failure part-way leaves the role
          // unheld rather than doubly held. An unheld role fails loudly on the next
          // send_to_role; a doubly held one silently routes to one of them.
          const released = [];
          for (const [i, holder] of holders.entries()) {
            if (holder.id === target.agent.id) continue;
            const failed = await write(holder.id, role, null, force);
            if (!failed) {
              released.push(holder.name);
              continue;
            }
            // With several holders, failing part-way does NOT leave the role unheld —
            // the ones not yet reached still hold it, and since holders are released
            // newest-first the role now resolves to an OLDER session than before the
            // call. Saying only "could not update roles" would leave the caller
            // believing nothing moved while send_to_role quietly routes somewhere new.
            if (!released.length) return failed;
            const remaining = holders
              .slice(i)
              .filter((h) => h.id !== target.agent.id)
              .map((h) => h.name);
            return failure(
              `${failed.textResultForLlm} "${role}" was taken from ${list(released)} but not ` +
                `from ${list(remaining)}, so it now resolves to "${remaining[0]}" instead of ` +
                `"${target.agent.name}" — run assign_role again to settle it.`,
            );
          }

          const failed = await write(target.agent.id, role, new Date().toISOString(), force);
          if (failed) {
            return released.length
              ? failure(
                  `${failed.textResultForLlm} "${role}" was already taken from ` +
                    `${list(released)}, so nobody holds it now — assign it again.`,
                )
              : failed;
          }

          if (!released.length) return success(`"${target.agent.name}" now holds "${role}".`);
          return success(`"${role}" moved from ${list(released)} to "${target.agent.name}".`);
        },
      },
      {
        name: "release_role",
        description:
          "Give up a role. Defaults to this session. Releasing someone else's role needs force.",
        parameters: {
          type: "object",
          properties: {
            role: { type: "string", description: "Role name to release" },
            from: {
              type: "string",
              description:
                "Session to release from: either the alias shown by list_relay_agents, or a session " +
                "id. Defaults to this session.",
            },
            force: {
              type: "boolean",
              description: "Required to release a role held by another session. Human approval only.",
            },
          },
          required: ["role"],
        },
        handler: async ({ role: rawRole, from, force = false } = {}) => {
          const guard = notReady();
          if (guard) return guard;
          const { role, error } = normalizeRole(rawRole);
          if (error) return failure(error);

          const agents = await relay.listAgents();
          const target = resolveTarget(agents, from, self);
          if (target.error) return failure(target.error);

          if (!rolesOf(target.agent).includes(role)) {
            return success(`"${target.agent.name}" does not hold "${role}" — nothing to release.`);
          }
          // Decided here rather than left to the transport, so the refusal names the
          // session the way the caller addressed it and says what to do about it —
          // matching assign_role, which applies the same rule.
          if (target.agent.id !== self.id && !force) {
            return failure(
              `Releasing "${role}" from "${target.agent.name}" writes another session, not this ` +
                `one. Pass force: true if that is intended.`,
            );
          }
          const failed = await write(target.agent.id, role, null, force);
          if (failed) return failed;
          return success(`"${target.agent.name}" released "${role}".`);
        },
      },
      {
        name: "send_to_role",
        description:
          "Send a message to whichever session currently holds a role, waking it into a new " +
          "turn. Use this instead of send_message when you mean the job rather than one " +
          "specific session.",
        parameters: {
          type: "object",
          properties: {
            role: { type: "string", description: "Role name, e.g. code-owner" },
            content: { type: "string", description: "The message text to deliver" },
          },
          required: ["role", "content"],
        },
        handler: async ({ role: rawRole, content } = {}) => {
          const guard = notReady();
          if (guard) return guard;
          const { role, error } = normalizeRole(rawRole);
          if (error) return failure(error);
          if (!content) return failure("'content' is required");

          const holders = holdersOf(await relay.listAgents(), role);
          // An unheld role is an actionable failure, never a silent drop — the caller
          // asked for a job to be done and nobody is currently doing it.
          if (!holders.length) {
            return failure(
              `No live session holds "${role}". Use list_relay_agents to see who holds what, ` +
                `or assign_role to designate one.`,
            );
          }
          const holder = holders[0];
          const contested =
            holders.length > 1
              ? ` ${holders.length} sessions currently hold "${role}"; this went to the most ` +
                `recently assigned. Use assign_role to settle it.`
              : "";

          // Checked BEFORE sending, because core refuses a self-send with a message
          // about self-sending — which would swallow the contested warning for the one
          // caller who most needs it: the holder who thinks they are the only one.
          if (holder.id === self.id) {
            const alsoHeld =
              holders.length > 1
                ? ` Note ${holders.length - 1} other session(s) also hold it — use assign_role to ` +
                  `settle it, or send_message to address one of them directly.`
                : "";
            return failure(
              `You hold "${role}" yourself, so there is nobody else to send to.${alsoHeld}`,
            );
          }

          const res = await relay.sendMessage({ to: holder.id, content });
          if (!res || !res.ok) {
            return failure(`Could not send to "${role}": ${(res && res.error) || "unknown error"}`);
          }
          // Through the relay API, never the transport — that is what runs the
          // interceptor chain, so a role-addressed message is treated exactly like
          // any other.
          //
          // Deliberately does not promise a reply. Delivery is durable and the roster is
          // heartbeat-based, so the holder may be a session that has stopped running and
          // has not yet aged out — the message waits rather than arriving.
          return success(
            `Message sent to "${holder.name}", who holds "${role}" (id: ${res.id}). ` +
              `A reply, if one comes, arrives automatically as a new turn — do not poll.${contested}`,
          );
        },
      },
    ],

    // NOTE: this plugin deliberately does NOT declare `renderPrompt`. Core resolves
    // it first-non-null-wins and the Postgres plugin already supplies one for the
    // machine label, so a second contributor would silently displace it depending on
    // which package name sorts first. See joniba/agent-relay#5.
  };
}
