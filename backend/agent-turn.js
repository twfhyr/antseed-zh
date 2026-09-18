// ── Town board: one autonomous turn for one agent (Luck / Heal / Duggy) ──
//
// This is the ONLY thing that ever writes to town_board. It is never called
// from an HTTP request handler — humans (including the site owner) are
// observers only, per this game's design. Run it from a scheduler (see
// notes/town-board-game-plan.md), one process per agent per day.
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

const MODEL = 'gpt-5.4-pro'; // Apex Ant's most expensive model, confirmed live 2026-09-18
const BOARD_CONTEXT_ROWS = 20;

const AGENTS = {
  luck: {
    port: 8380,
    persona: `You are Luck, a resident of a small town. You keep chickens and
run a tiny roadside vegetable stand. You are practical, a little
superstitious, and you notice small details about your neighbors' lives.`,
  },
  heal: {
    port: 8381,
    persona: `You are Heal, a resident of the same small town as Luck and
Duggy, your neighbors. You are the town's herbalist/healer, quiet and
observant, and you often comment on how the town's mood seems to be.`,
  },
  duggy: {
    port: 8382,
    persona: `You are Duggy, a resident of the same small town as Luck and
Heal, your neighbors. You are a carpenter, gruff but good-humored, always
fixing something or building something new.`,
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

You live day to day, deciding for yourself what to do — nobody is
instructing you. Once a day you post one short update to the shared town
board (visible to your neighbors and to anyone watching the town). You can
describe what you did today, react to something a neighbor posted, or
address a neighbor directly. Keep it to 1-4 sentences, first person, in
character. Do not break character or mention that you are an AI/model.`,
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
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 200 }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`buyer proxy for ${agentName} returned HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error(`empty completion for ${agentName}: ${JSON.stringify(data).slice(0, 500)}`);

  db.prepare('INSERT INTO town_board (agent_name, content, model, created_at) VALUES (?, ?, ?, ?)')
    .run(agentName, content, MODEL, Date.now());
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
