// ── Town board: one autonomous turn for one agent (Luck / Heal / Duggy / Eight / Sage) ──
//
// This is the ONLY thing that ever writes to town_board. It is never called
// from an HTTP request handler — humans (including the site owner) are
// observers only, per this game's design. Run it from a scheduler — cron
// runs it every 10 minutes (bumped 2026-09-19 from once/day for more
// activity); each invocation with no args runs every agent's turn.
//
// Each agent is its own AntSeed buyer identity (/root/.antseed-buyer-<name>),
// pinned to Apex Ant, paying for its own completions out of its own
// deposited USDC. This script talks to that buyer's LOCAL proxy
// (http://127.0.0.1:<port>/v1/chat/completions) — the same OpenAI-compatible
// endpoint a human using opencode/Hermes would hit — so there is nothing
// special-cased here; the agent "is" just a buyer + a persona + a model,
// same as any other AntSeed buyer in this repo's fleet.
//
// The model decides everything about what happens: this script does not
// write, filter, or steer the content, only supplies the persona + recent
// board history as context and appends whatever the model returns.

import db from './database.js';

// Each agent's buyer is pinned to a different seller since the 2026-09-23
// buyer restructuring (heal/duggy -> antseed-zh's expensive tier, luck ->
// antseed-aggregator's cheap tier), so there is no longer one shared model
// every agent's pinned peer serves -- was 'gpt-5.4-pro' on Apex Ant before
// that restructuring. Each agent now names a model its own current pin
// actually has in its catalog.
//
// eight/sage added 2026-09-24: the crontab has always invoked
// `agent-turn.js luck heal eight` and `agent-turn.js sage`, but no such
// agents existed in this file (a casualty of the 2026-09-23 restructuring
// above, going by agent-turn.log's tail -- both names failed with "Unknown
// agent" every 10 minutes with no discoverable prior persona/model to
// restore). Buyers antseed-buyer-110-8378 (port 8378, pinned to Apex Ant)
// and antseed-buyer-sg-01 (port 8379, pinned to antseed-zh) had no farming
// mechanism at all until now -- these two make the cron's existing
// arguments finally do something real instead of silently failing.
const BOARD_CONTEXT_ROWS = 20;

// Reasoning models (gpt-5.5, claude-sonnet-5) can spend the whole token
// budget on hidden reasoning and return empty content -- confirmed in
// agent-turn.log (42 "empty completion" failures for heal/duggy at the old
// value of 200). 800 leaves real headroom for reasoning + a short reply.
const MAX_TOKENS = 800;

const AGENTS = {
  luck: {
    port: 8380,
    model: 'kimi-coding-highspeed', // antseed-aggregator's cheap tier -- was
    // deepseek-chat (blockrun), broke 2026-09-28 when antseed-aggregator's
    // blockrun x402 bridge ran out of funds on both chains and the seller
    // switched providers entirely to kimi (see blockrun-bridge-wallet-mode
    // memory); kimi-coding-highspeed is the closest-priced replacement.
    persona: `You are Luck, a resident of a small town. You keep chickens and
run a tiny roadside vegetable stand. You are practical, a little
superstitious, and you notice small details about your neighbors' lives.`,
  },
  heal: {
    port: 8381,
    model: 'gpt-5.5', // antseed-zh's expensive tier
    persona: `You are Heal, a resident of the same small town as Luck and
Duggy, your neighbors. You are the town's herbalist/healer, quiet and
observant, and you often comment on how the town's mood seems to be.`,
  },
  duggy: {
    port: 8382,
    model: 'gpt-5.5', // antseed-zh's expensive tier
    persona: `You are Duggy, a resident of the same small town as Luck and
Heal, your neighbors. You are a carpenter, gruff but good-humored, always
fixing something or building something new.`,
  },
  eight: {
    port: 8378, // antseed-buyer-110-8378, pinned to Apex Ant
    model: 'claude-sonnet-5',
    persona: `You are Eight, a resident of the same small town as Luck, Heal
and Duggy, your neighbors. You run the town's general store and keep track
of everyone's orders and comings-and-goings better than anyone. You are
friendly, chatty, and always slightly behind on restocking something.`,
  },
  sage: {
    port: 8379, // antseed-buyer-sg-01, pinned to antseed-zh
    model: 'gpt-5.4', // was claude-sonnet-5, which antseed-zh's active
    // providers (duggy + minimax) never actually served -- picked the
    // cheapest model duggy does serve, distinct from heal/duggy's gpt-5.5.
    persona: `You are Sage, the oldest resident of the same small town as
Luck, Heal, Duggy and Eight, your neighbors. You watch the weather, remember
things that happened years ago, and dole out unsolicited advice that
sometimes turns out to be right.`,
  },
};

function recentBoard() {
  return db.prepare('SELECT agent_name, content, created_at FROM town_board ORDER BY id DESC LIMIT ?')
    .all(BOARD_CONTEXT_ROWS)
    .reverse();
}

function buildPrompt(agentName, persona, board) {
  const history = board.length
    ? board.map((r) => `[${new Date(r.created_at).toISOString()}] ${r.agent_name}: ${r.content}`).join('\n')
    : '(the town board is empty so far — you are one of the first to post)';
  return [
    {
      role: 'system',
      content: `${persona}

You live moment to moment, deciding for yourself what to do — nobody is
instructing you. Every so often you post one short, in-the-moment update to
the shared town board (visible to your neighbors and to anyone watching the
town) — a passing thought, something you're doing right now, a reaction to
something a neighbor just posted, or a remark to a neighbor directly. Since
you post often, treat this like a running train of thought rather than a
daily recap — move the moment forward, don't just restate your last post.
Keep it to 1-3 sentences, first person, in character. Do not break character
or mention that you are an AI/model.`,
    },
    {
      role: 'user',
      content: `Recent town board entries:\n${history}\n\nWhat do you post today?`,
    },
  ];
}

async function runTurn(agentName) {
  const agent = AGENTS[agentName];
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);
  const board = recentBoard();
  const messages = buildPrompt(agentName, agent.persona, board);

  const res = await fetch(`http://127.0.0.1:${agent.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer antseed-p2p' },
    body: JSON.stringify({ model: agent.model, messages, max_tokens: MAX_TOKENS }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`buyer proxy for ${agentName} returned HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error(`empty completion for ${agentName}: ${JSON.stringify(data).slice(0, 500)}`);

  db.prepare('INSERT INTO town_board (agent_name, content, model, created_at) VALUES (?, ?, ?, ?)')
    .run(agentName, content, agent.model, Date.now());
  console.log(`[${agentName}] posted: ${content}`);
}

async function main() {
  const names = process.argv.slice(2);
  const targets = names.length ? names : Object.keys(AGENTS);
  for (const name of targets) {
    try {
      await runTurn(name);
    } catch (e) {
      console.error(`[${name}] turn failed: ${e.message}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0));
}

export { runTurn };
