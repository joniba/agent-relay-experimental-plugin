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

/** Every role an agent entry currently publishes. */
function rolesOf(agent) {
  const attributes = (agent && agent.attributes) || {};
  return Object.keys(attributes)
    .filter((k) => k.startsWith(ROLE_PREFIX) && k.length > ROLE_PREFIX.length)
    .map((k) => k.slice(ROLE_PREFIX.length));
}

/** The live holder of a role, or null. */
function holderOf(agents, role) {
  return agents.find((a) => rolesOf(a).includes(role)) ?? null;
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
      return failure("The roles plugin has not finished starting up — try again in a moment.");
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
      "which survives the alias changes that happen every restart. Prefer send_to_role over " +
      "send_message when you mean 'whoever currently holds this job' rather than one specific " +
      "session; list_relay_agents shows who holds what. Use assign_role to designate a session.",

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
        const holder = agents.find((a) => a.id !== self.id && rolesOf(a).includes(role));
        if (!holder) continue;
        // Addressed explicitly rather than relying on the seam's default, so the
        // write is unambiguous at the call site.
        await relay.setAttributes({ id: self.id, attributes: { [ROLE_PREFIX + role]: null } });
        ctx.log?.(
          `roles: released "${role}" — ${holder.name} holds it now`,
          { level: "warning" },
        );
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
            to: { type: "string", description: "Target session name or id (default: this session)" },
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

          const holder = holderOf(agents, role);
          if (holder && holder.id === target.agent.id) {
            return success(`"${target.agent.name}" already holds "${role}".`);
          }

          // Displacing is a separate write to somebody else's entry, judged on its own.
          if (holder) {
            const failed = await write(holder.id, role, null, force);
            if (failed) return failed;
          }
          const failed = await write(target.agent.id, role, new Date().toISOString(), force);
          if (failed) return failed;

          return success(
            holder
              ? `"${role}" moved from "${holder.name}" to "${target.agent.name}".`
              : `"${target.agent.name}" now holds "${role}".`,
          );
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
            from: { type: "string", description: "Session name or id (default: this session)" },
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

          const holder = holderOf(await relay.listAgents(), role);
          // An unheld role is an actionable failure, never a silent drop — the caller
          // asked for a job to be done and nobody is currently doing it.
          if (!holder) {
            return failure(
              `No live session holds "${role}". Use list_relay_agents to see who holds what, ` +
                `or assign_role to designate one.`,
            );
          }

          // Through the relay API, never the transport — that is what runs the
          // interceptor chain, so a role-addressed message is treated exactly like
          // any other.
          const res = await relay.sendMessage({ to: holder.id, content });
          return res && res.ok
            ? success(
                `Message sent to "${holder.name}", who holds "${role}" (id: ${res.id}). ` +
                  `Any reply arrives automatically as a new turn — do not poll.`,
              )
            : failure(`Could not send to "${role}": ${(res && res.error) || "unknown error"}`);
        },
      },
    ],

    // NOTE: this plugin deliberately does NOT declare `renderPrompt`. Core resolves
    // it first-non-null-wins and the Postgres plugin already supplies one for the
    // machine label, so a second contributor would silently displace it depending on
    // which package name sorts first. See joniba/agent-relay#5.
  };
}
