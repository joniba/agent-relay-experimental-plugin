import { test } from "node:test";
import assert from "node:assert/strict";

import createPlugin from "../index.mjs";

// -- a fake relay standing in for the handle core passes to activate ----------

function fakeRelay(agents = []) {
  const sent = [];
  const writes = [];
  const relay = {
    agents,
    sent,
    writes,
    async listAgents() {
      return relay.agents;
    },
    async sendMessage({ to, content }) {
      sent.push({ to, content });
      return { ok: true, id: "m-1" };
    },
    async setAttributes({ id, attributes, force = false }) {
      // Mirrors the seam contract: `id` defaults to this session.
      const target = id ?? relay.selfId;
      writes.push({ id: target, attributes, force });
      const agent = relay.agents.find((a) => a.id === target);
      if (!agent) return { ok: false, error: `no such agent: ${target}` };
      if (target !== relay.selfId && !force) {
        return { ok: false, error: `refusing to write attributes on another session (${target}) without force` };
      }
      agent.attributes = agent.attributes ?? {};
      for (const [k, v] of Object.entries(attributes)) {
        if (v === null) delete agent.attributes[k];
        else agent.attributes[k] = v;
      }
      return { ok: true, attributes: { ...agent.attributes } };
    },
  };
  return relay;
}

const agent = (id, name, roles = {}) => ({
  id,
  name,
  attributes: Object.fromEntries(Object.entries(roles).map(([r, t]) => [`role.${r}`, t])),
});

/** Bring the plugin up against a roster, as core would. */
async function up(agents, selfId = "s-me") {
  const warnings = [];
  // Core hands the diagnostic log to the FACTORY, and passes only { relay, self } to
  // activate — so that is where a plugin's warnings surface.
  const plugin = createPlugin({
    env: {},
    dataDir: null,
    log: (msg, opts) => warnings.push({ msg, ...opts }),
  });
  const relay = fakeRelay(agents);
  relay.selfId = selfId;
  const self = agents.find((a) => a.id === selfId) ?? { id: selfId, name: "loon" };
  await plugin.activate({ relay, self: { id: self.id, name: self.name } });
  const tool = (name) => plugin.tools.find((t) => t.name === name);
  return { plugin, relay, tool, warnings, self };
}

// -- registration shape -------------------------------------------------------

test("registers three tools and briefing text, and NO renderPrompt", async () => {
  const plugin = createPlugin({ env: {} });
  assert.deepEqual(plugin.tools.map((t) => t.name).sort(), ["assign_role", "release_role", "send_to_role"]);
  assert.match(plugin.briefing, /send_to_role/);
  // Core resolves renderPrompt first-non-null-wins and the pg plugin already
  // supplies one, so a second contributor would silently displace the machine
  // label depending on which package name sorts first. joniba/agent-relay#5.
  assert.equal(plugin.interceptors, undefined);
});

test("every tool declares force where it can write another session", async () => {
  const plugin = createPlugin({ env: {} });
  for (const name of ["assign_role", "release_role"]) {
    const tool = plugin.tools.find((t) => t.name === name);
    assert.ok(tool.parameters.properties.force, `${name} must surface force to the caller`);
  }
});

// -- assign -------------------------------------------------------------------

test("assign_role defaults to this session and records when", async () => {
  const { relay, tool } = await up([agent("s-me", "loon")]);
  const res = await tool("assign_role").handler({ role: "code-owner" });

  assert.equal(res.resultType, "success");
  const stored = relay.agents[0].attributes["role.code-owner"];
  assert.ok(Date.parse(stored), "the value should be the assignment timestamp");
});

test("assign_role normalises the name and rejects an unusable one", async () => {
  const { relay, tool } = await up([agent("s-me", "loon")]);
  await tool("assign_role").handler({ role: "  Code-Owner  " });
  assert.ok("role.code-owner" in relay.agents[0].attributes);

  for (const bad of ["has space", "-leading", "UPPER!", "", "x".repeat(65)]) {
    const res = await tool("assign_role").handler({ role: bad });
    assert.equal(res.resultType, "failure", `"${bad}" should be rejected`);
  }
});

test("assigning a role nobody holds needs no force", async () => {
  const { tool } = await up([agent("s-me", "loon")]);
  const res = await tool("assign_role").handler({ role: "code-owner" });
  assert.equal(res.resultType, "success");
});

test("displacing a live holder needs force EVEN when assigning to yourself", async () => {
  // The displacement is a write to somebody else's entry, so the gate applies
  // regardless of who the role is being given to.
  const agents = [agent("s-me", "loon"), agent("s-them", "gull", { "code-owner": "2026-01-01" })];
  const { tool, relay } = await up(agents);

  const refused = await tool("assign_role").handler({ role: "code-owner" });
  assert.equal(refused.resultType, "failure");
  assert.match(refused.textResultForLlm, /Pass force: true/);
  // And nothing moved.
  assert.ok("role.code-owner" in relay.agents[1].attributes);
  assert.ok(!("role.code-owner" in relay.agents[0].attributes));

  const forced = await tool("assign_role").handler({ role: "code-owner", force: true });
  assert.equal(forced.resultType, "success");
  assert.match(forced.textResultForLlm, /moved from "gull" to "loon"/);
  assert.ok(!("role.code-owner" in relay.agents[1].attributes), "previous holder must stop holding it");
  assert.ok("role.code-owner" in relay.agents[0].attributes);
});

test("a refused hand-off writes NOTHING — it must not strip the incumbent first", async () => {
  // The transport judges each write on its own, and releasing your OWN role is a
  // self-write it allows. Leaving the gate to it therefore let a refused hand-off
  // take the role off its holder and give it to nobody, while reporting a refusal.
  const agents = [agent("s-me", "loon", { "code-owner": "2026-01-01" }), agent("s-them", "gull")];
  const { tool, relay } = await up(agents);

  const refused = await tool("assign_role").handler({ role: "code-owner", to: "gull" });
  assert.equal(refused.resultType, "failure");
  assert.equal(relay.writes.length, 0, "a refusal must be decided before any write");
  assert.ok("role.code-owner" in relay.agents[0].attributes, "the incumbent must keep the role");
});

test("a hand-off that fails part-way says the role is now unheld", async () => {
  const agents = [agent("s-me", "loon", { "code-owner": "2026-01-01" }), agent("s-them", "gull")];
  const { tool, relay } = await up(agents);
  // Release succeeds, then the assign fails — the target died in the window, say.
  let calls = 0;
  const real = relay.setAttributes;
  relay.setAttributes = async (args) =>
    ++calls === 2 ? { ok: false, error: "transport unavailable" } : real(args);

  const res = await tool("assign_role").handler({ role: "code-owner", to: "gull", force: true });
  assert.equal(res.resultType, "failure");
  assert.match(res.textResultForLlm, /nobody holds it now/);
  assert.match(res.textResultForLlm, /assign it again/);
});

test("assign_role displaces EVERY holder, not just the first", async () => {
  // Two sessions can each assign a role to themselves without either being refused,
  // so duplicates are reachable and an assignment has to converge them.
  const agents = [
    agent("s-me", "loon"),
    agent("s-a", "gull", { "code-owner": "2026-01-01" }),
    agent("s-b", "tern", { "code-owner": "2026-02-02" }),
  ];
  const { tool, relay } = await up(agents);

  const res = await tool("assign_role").handler({ role: "code-owner", force: true });
  assert.equal(res.resultType, "success");
  assert.ok(!("role.code-owner" in relay.agents[1].attributes));
  assert.ok(!("role.code-owner" in relay.agents[2].attributes));
  assert.ok("role.code-owner" in relay.agents[0].attributes);
  assert.match(res.textResultForLlm, /moved from "tern" and "gull" to "loon"/);
});

test("assigning to another session by name needs force", async () => {
  const agents = [agent("s-me", "loon"), agent("s-them", "gull")];
  const { tool } = await up(agents);

  const refused = await tool("assign_role").handler({ role: "code-owner", to: "gull" });
  assert.equal(refused.resultType, "failure");

  const forced = await tool("assign_role").handler({ role: "code-owner", to: "gull", force: true });
  assert.equal(forced.resultType, "success");
});

test("assigning a role its holder already has is a no-op success", async () => {
  const agents = [agent("s-me", "loon", { "code-owner": "2026-01-01" })];
  const { tool, relay } = await up(agents);
  const res = await tool("assign_role").handler({ role: "code-owner" });

  assert.equal(res.resultType, "success");
  assert.match(res.textResultForLlm, /already holds/);
  assert.equal(relay.writes.length, 0, "an unchanged assignment should write nothing");
});

test("an ambiguous name is refused rather than guessed", async () => {
  const agents = [agent("s-me", "loon"), agent("s-a", "gull"), agent("s-b", "gull")];
  const { tool } = await up(agents);
  const res = await tool("assign_role").handler({ role: "code-owner", to: "gull", force: true });
  assert.equal(res.resultType, "failure");
  assert.match(res.textResultForLlm, /matches 2 live sessions/);
});

// -- release ------------------------------------------------------------------

test("release_role gives up your own role without force", async () => {
  const agents = [agent("s-me", "loon", { "code-owner": "2026-01-01" })];
  const { tool, relay } = await up(agents);
  const res = await tool("release_role").handler({ role: "code-owner" });

  assert.equal(res.resultType, "success");
  assert.ok(!("role.code-owner" in relay.agents[0].attributes));
});

test("releasing someone else's role needs force", async () => {
  const agents = [agent("s-me", "loon"), agent("s-them", "gull", { "code-owner": "2026-01-01" })];
  const { tool } = await up(agents);

  const refused = await tool("release_role").handler({ role: "code-owner", from: "gull" });
  assert.equal(refused.resultType, "failure");
  // Refused by the plugin, naming the session the way the caller addressed it — not by
  // the transport, which would name a raw session id and prescribe nothing.
  assert.match(refused.textResultForLlm, /from "gull"/);
  assert.match(refused.textResultForLlm, /Pass force: true/);

  const forced = await tool("release_role").handler({ role: "code-owner", from: "gull", force: true });
  assert.equal(forced.resultType, "success");
});

test("releasing a role you do not hold is a harmless success", async () => {
  const { tool, relay } = await up([agent("s-me", "loon")]);
  const res = await tool("release_role").handler({ role: "code-owner" });
  assert.equal(res.resultType, "success");
  assert.equal(relay.writes.length, 0);
});

// -- send_to_role -------------------------------------------------------------

test("send_to_role delivers to the current holder through the relay API", async () => {
  const agents = [agent("s-me", "loon"), agent("s-them", "gull", { "code-owner": "2026-01-01" })];
  const { tool, relay } = await up(agents);

  const res = await tool("send_to_role").handler({ role: "code-owner", content: "please review" });
  assert.equal(res.resultType, "success");
  // Sent by id, through sendMessage — so the interceptor chain runs exactly as it
  // does for any other message.
  assert.deepEqual(relay.sent, [{ to: "s-them", content: "please review" }]);
  assert.match(res.textResultForLlm, /"gull", who holds "code-owner"/);
});

test("send_to_role picks the newest claim and says the role is contested", async () => {
  const agents = [
    agent("s-me", "loon"),
    agent("s-a", "gull", { "code-owner": "2026-01-01" }),
    agent("s-b", "tern", { "code-owner": "2026-02-02" }),
  ];
  const { tool, relay } = await up(agents);

  const res = await tool("send_to_role").handler({ role: "code-owner", content: "ping" });
  assert.equal(res.resultType, "success");
  assert.equal(relay.sent[0].to, "s-b", "the most recent assignment wins");
  assert.match(res.textResultForLlm, /2 sessions currently hold/);
});

test("send_to_role refuses when nobody live holds the role", async () => {
  const { tool, relay } = await up([agent("s-me", "loon")]);
  const res = await tool("send_to_role").handler({ role: "code-owner", content: "hi" });

  assert.equal(res.resultType, "failure");
  assert.match(res.textResultForLlm, /No live session holds "code-owner"/);
  assert.equal(relay.sent.length, 0, "an unheld role must never be a silent drop");
});

test("send_to_role requires content", async () => {
  const agents = [agent("s-me", "loon", { "code-owner": "2026-01-01" })];
  const { tool } = await up(agents);
  const res = await tool("send_to_role").handler({ role: "code-owner" });
  assert.equal(res.resultType, "failure");
});

// -- the startup conflict repair ----------------------------------------------

test("a returning session YIELDS a role another live session now holds", async () => {
  // A resumed session keeps its entry and the roles on it, but a restart is not a
  // decision about who should hold a role — whereas the assignment in between was.
  const agents = [
    agent("s-me", "loon", { "code-owner": "2026-01-01" }),
    agent("s-them", "gull", { "code-owner": "2026-02-02" }),
  ];
  const { relay, warnings } = await up(agents);

  assert.ok(!("role.code-owner" in relay.agents[0].attributes), "the returning session must yield");
  assert.ok("role.code-owner" in relay.agents[1].attributes, "the current holder keeps it");
  assert.match(warnings[0].msg, /released "code-owner" — gull holds it now/);
  assert.equal(warnings[0].level, "warning");
});

test("a returning session KEEPS a role nobody else took", async () => {
  const agents = [agent("s-me", "loon", { "code-owner": "2026-01-01" })];
  const { relay, warnings } = await up(agents);

  assert.ok("role.code-owner" in relay.agents[0].attributes);
  assert.equal(warnings.length, 0);
});

test("only the OLDER claim yields — two returning sessions must not both release", async () => {
  // The check is otherwise symmetric, so each would see the other holding the role
  // and each would release it, leaving the role held by nobody.
  const older = [
    agent("s-me", "loon", { "code-owner": "2026-01-01" }),
    agent("s-them", "gull", { "code-owner": "2026-02-02" }),
  ];
  const a = await up(older);
  assert.ok(!("role.code-owner" in a.relay.agents[0].attributes), "the older claim yields");

  const newer = [
    agent("s-me", "loon", { "code-owner": "2026-03-03" }),
    agent("s-them", "gull", { "code-owner": "2026-02-02" }),
  ];
  const b = await up(newer);
  assert.ok("role.code-owner" in b.relay.agents[0].attributes, "the newer claim keeps it");
  assert.equal(b.warnings.length, 0);
});

test("activation does not claim a release it could not perform", async () => {
  const agents = [
    agent("s-me", "loon", { "code-owner": "2026-01-01" }),
    agent("s-them", "gull", { "code-owner": "2026-02-02" }),
  ];
  const warnings = [];
  const plugin = createPlugin({ env: {}, log: (msg, o) => warnings.push({ msg, ...o }) });
  const relay = fakeRelay(agents);
  relay.selfId = "s-me";
  // A transport with no attribute support reports it by returning, not by throwing.
  relay.setAttributes = async () => ({ ok: false, error: "not supported by the active transport" });

  await plugin.activate({ relay, self: { id: "s-me", name: "loon" } });

  assert.match(warnings[0].msg, /still advertising "code-owner"/);
  assert.match(warnings[0].msg, /not supported by the active transport/);
  assert.equal(warnings[0].level, "warning");
});

test("the conflict check only touches the contested role", async () => {
  const agents = [
    agent("s-me", "loon", { "code-owner": "2026-01-01", reviewer: "2026-01-01" }),
    agent("s-them", "gull", { "code-owner": "2026-02-02" }),
  ];
  const { relay } = await up(agents);

  assert.ok(!("role.code-owner" in relay.agents[0].attributes));
  assert.ok("role.reviewer" in relay.agents[0].attributes, "an uncontested role must be left alone");
});

// -- degradation --------------------------------------------------------------

test("an older core without setAttributes fails activation with an actionable message", async () => {
  const plugin = createPlugin({ env: {} });
  const relay = { listAgents: async () => [], sendMessage: async () => ({ ok: true }) };

  await assert.rejects(
    () => plugin.activate({ relay, self: { id: "s-me", name: "loon" } }),
    /needs a newer agent-relay core/,
  );

  // And its tools then say so, rather than throwing on an undefined method.
  const res = await plugin.tools.find((t) => t.name === "assign_role").handler({ role: "x" });
  assert.equal(res.resultType, "failure");
  assert.match(res.textResultForLlm, /newer agent-relay core/);
});

test("tools called before activation name the permanent possibility, not just a retry", async () => {
  // A core with plugin tools but no activation hook never calls activate, so this
  // state never resolves — advising a retry alone would be advice that cannot work.
  const plugin = createPlugin({ env: {} });
  const res = await plugin.tools.find((t) => t.name === "send_to_role").handler({ role: "x", content: "y" });
  assert.equal(res.resultType, "failure");
  assert.match(res.textResultForLlm, /has not activated/);
  assert.match(res.textResultForLlm, /does not support plugin activation/);
});

test("send_to_role tells the holder they hold it, instead of core's self-send error", async () => {
  // Core refuses a self-send with a message about self-sending, which would swallow
  // the contested warning for the caller who most needs it: the most-recent holder,
  // who believes they are the only one.
  const agents = [
    agent("s-me", "loon", { "code-owner": "2026-03-03" }),
    agent("s-them", "gull", { "code-owner": "2026-01-01" }),
  ];
  const { tool, relay } = await up(agents);

  const res = await tool("send_to_role").handler({ role: "code-owner", content: "ping" });
  assert.equal(res.resultType, "failure");
  assert.match(res.textResultForLlm, /You hold "code-owner" yourself/);
  assert.match(res.textResultForLlm, /1 other session/, "the contested state must still surface");
  assert.equal(relay.sent.length, 0, "nothing should be sent");
});

test("send_to_role does not promise a reply it cannot guarantee", async () => {
  // The roster is heartbeat-based, so a holder may be a session that has stopped and
  // not yet aged out. Delivery is durable; arrival is not.
  const agents = [agent("s-me", "loon"), agent("s-them", "gull", { "code-owner": "2026-01-01" })];
  const { tool } = await up(agents);

  const res = await tool("send_to_role").handler({ role: "code-owner", content: "ping" });
  assert.equal(res.resultType, "success");
  assert.match(res.textResultForLlm, /if one comes/);
});

test("a release that fails part-way says the role moved to whoever is left", async () => {
  // With several holders this does NOT leave the role unheld: the ones not yet
  // reached still hold it, and since holders are released newest-first it now
  // resolves to an OLDER session than before the call. Reporting only the transport
  // error would leave the caller believing nothing moved.
  const agents = [
    agent("s-me", "loon"),
    agent("s-a", "gull", { "code-owner": "2026-01-01" }),
    agent("s-b", "tern", { "code-owner": "2026-02-02" }),
  ];
  const { tool, relay } = await up(agents);
  let calls = 0;
  const real = relay.setAttributes;
  relay.setAttributes = async (args) =>
    ++calls === 2 ? { ok: false, error: "transport unavailable" } : real(args);

  const res = await tool("assign_role").handler({ role: "code-owner", force: true });

  assert.equal(res.resultType, "failure");
  assert.match(res.textResultForLlm, /taken from "tern"/, "must name who was stripped");
  assert.match(res.textResultForLlm, /resolves to "gull"/, "must name who it landed on");
  assert.match(res.textResultForLlm, /assign_role again/);
  // And that is genuinely the state: gull still holds it, loon never got it.
  assert.ok("role.code-owner" in relay.agents[1].attributes);
  assert.ok(!("role.code-owner" in relay.agents[0].attributes));
});
