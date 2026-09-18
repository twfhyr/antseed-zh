// Model taxonomy: maps a raw service `name` from /api/services to a
// (company, family) pair, so the "By model" view can offer a two-level
// filter (pick "OpenAI" -> pick "GPT-5.6") instead of one flat list of ~400
// model names, which is unusable as a filter.
//
// WHY THIS IS HEURISTIC, AND WHAT THAT DOES / DOESN'T AFFECT:
// Model names are NOT normalized across sellers — the live network carries
// `gpt-5.2`, `gpt-52` and `openai-gpt-52`; `claude-opus-4-6` and
// `claude-opus-4.6`; `qwen/qwen3.6-27b` and `qwen3-6-27b`. Each seller types
// whatever it wants into its signed PeerMetadata. So this file pattern-matches
// brand names and version numbers.
//
// This classification is used ONLY to decide which model groups are VISIBLE
// under a filter chip. It never merges two differently-named models into one
// price row, never changes a displayed price, and never invents a model that
// no seller listed. A misclassification hides/shows a row under the wrong
// chip; it cannot produce a wrong number. Anything unrecognized falls into
// company "Other" rather than being guessed into a brand.

/**
 * Prefixes sellers bolt onto an otherwise-standard model name: HF-style org
 * namespaces (`openai/`, `moonshotai/`), flattened versions of the same
 * (`zai-org-`, `openai-gpt-...`), and deployment markers (`e2ee-` = the TEE
 * builds some sellers run). Stripped for classification only — the original
 * name is always what gets displayed.
 */
// Vendor/namespace prefixes seen on the AntSeed network AND in the
// OpenRouter model catalogue we match against for reference pricing — the
// two lists have to agree, or a model matches itself under one spelling and
// misses its own reference price under another.
const ORGS = 'openai|google|nvidia|moonshotai|meta-llama|deepseek|qwen|z-ai|zai-org|aion-labs|xiaomi|olafangensan|meta|mistralai|alibaba'
  + '|anthropic|x-ai|xai|stepfun|tencent|bytedance|bytedance-seed|minimax|inception|nousresearch|cohere|microsoft|amazon|baidu|perplexity|writer|upstage|liquid|arcee-ai|ibm-granite|inclusionai|thinkingmachines|morph|sakana|rekaai';

// `org/model` is unambiguous — the slash proves it's a namespace, so always strip.
const SLASH_PREFIX = new RegExp(`^(${ORGS})/`);
// `org-model` is ambiguous: in `openai-gpt-52` the `openai-` is a redundant
// namespace, but in `deepseek-v4-flash` the `deepseek-` IS the model name.
// Only strip the dash form when what follows still starts with a brand token,
// otherwise we'd eat the brand and drop the model into "Other".
const DASH_PREFIX = new RegExp(`^(${ORGS})-(?=(gpt|gemma|gemini|nemotron|llama|glm|qwen|kimi|mimo|muse|deepseek|aion)\\b)`);
const DEPLOY_PREFIX = /^e2ee-/;

function stripPrefixes(raw) {
  let s = raw;
  // Loop: names like `e2ee-gpt-oss-120b-p` carry more than one prefix.
  for (let i = 0; i < 4; i++) {
    const next = s.replace(DEPLOY_PREFIX, '').replace(SLASH_PREFIX, '').replace(DASH_PREFIX, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * Pull a version off the front of `s`, tolerating every separator style the
 * network actually uses: `5.2`, `5-2`, `52` all mean 5.2.
 *
 * The `(?!\d)` guards are what keep date-stamped names honest:
 * `claude-sonnet-4-20250514` must read as major version 4, NOT 4.2 — without
 * the lookahead, `4-2` would match and the release date would be silently
 * turned into a minor version number.
 */
function takeVersion(s) {
  let m = /^(\d)[.\-](\d{1,2})(?!\d)/.exec(s);           // 5.2 / 5-2 / 4.20
  if (m) return `${m[1]}.${m[2]}`;
  m = /^(\d)(\d)(?!\d)/.exec(s);                          // 52 -> 5.2
  if (m) return `${m[1]}.${m[2]}`;
  m = /^(\d+)(?!\d)/.exec(s);                             // 5 / 2603
  if (m) return m[1];
  return '';
}

function after(s, re) {
  const m = re.exec(s);
  return m ? s.slice(m.index + m[0].length) : '';
}

const join = (...parts) => parts.filter(Boolean).join(' ');

/**
 * Ordered rules. First match wins, so put specific brands (gpt-oss, which is
 * OpenAI-named but often served by others) above generic ones.
 * `family(base)` returns the level-2 label; '' means "fall back to the raw
 * model name", which is the honest answer for one-off models.
 */
const RULES = [
  {
    id: 'openai', label: 'OpenAI',
    test: b => /^gpt|^o[13]-/.test(b),
    family: b => {
      if (/^gpt-?image/.test(b)) return 'GPT Image';
      if (/^gpt-oss/.test(b)) return 'GPT-OSS';
      if (/^gpt-4o/.test(b)) return 'GPT-4o';
      const v = takeVersion(after(b, /^gpt-?/));
      return v ? `GPT-${v}` : '';
    },
  },
  {
    id: 'anthropic', label: 'Anthropic',
    test: b => /claude|(^|-)(opus|sonnet|haiku|fable)-/.test(b),
    family: b => {
      const m = /(opus|sonnet|haiku|fable)/.exec(b);
      if (!m) return '';
      const tier = m[1][0].toUpperCase() + m[1].slice(1);
      const v = takeVersion(after(b, new RegExp(`${m[1]}-`)));
      // "fable" ships without the Claude brand on some sellers; keep its own
      // label rather than asserting it's a Claude model.
      const brand = m[1] === 'fable' ? '' : 'Claude';
      return join(brand, tier, v);
    },
  },
  {
    id: 'google', label: 'Google',
    test: b => /^gemini|^gemma|nano-banana/.test(b),
    family: b => {
      if (/nano-banana/.test(b)) return 'Nano Banana';
      if (/^gemini/.test(b)) return join('Gemini', takeVersion(after(b, /^gemini-/)));
      return join('Gemma', takeVersion(after(b, /^gemma-/)));
    },
  },
  {
    id: 'anthropic-x', label: 'xAI',
    test: b => /^grok/.test(b),
    family: b => {
      if (/imagine/.test(b)) return 'Grok Imagine';
      if (/^grok-build/.test(b)) return 'Grok Build';
      return join('Grok', takeVersion(after(b, /^grok-?/)));
    },
  },
  {
    id: 'deepseek', label: 'DeepSeek',
    test: b => /^deepseek/.test(b),
    family: b => {
      // Strip a second `deepseek-` for `deepseek/deepseek-v4-flash`.
      const rest = after(b, /^deepseek[/-]?/).replace(/^deepseek-/, '');
      if (/^r\d/.test(rest)) return `DeepSeek R${takeVersion(rest.slice(1))}`;
      const v = takeVersion(rest.replace(/^v/, ''));
      return v ? `DeepSeek V${v}` : '';
    },
  },
  {
    id: 'zai', label: 'Z.ai (GLM)',
    test: b => /^glm/.test(b),
    family: b => join('GLM', takeVersion(after(b, /^glm-?/))),
  },
  {
    id: 'alibaba', label: 'Alibaba (Qwen)',
    test: b => /^qwen|^wan-|^z-image/.test(b),
    family: b => {
      if (/^z-image/.test(b)) return 'Z-Image';
      if (/^wan-/.test(b)) return join('Wan', takeVersion(after(b, /^wan-/)));
      if (/^qwen-?image/.test(b)) return 'Qwen Image';
      if (/-vl/.test(b)) return 'Qwen VL';
      if (/coder/.test(b)) return 'Qwen Coder';
      // Strip a second `qwen-` for `qwen/qwen-2.5-7b-instruct`, then read the
      // version. Handles `qwen3.6-27b`, `qwen-3-6-plus` and `qwen-2.5-7b`
      // alike, since takeVersion() accepts `.`, `-` and run-together digits.
      const rest = after(b, /^qwen-?/).replace(/^qwen-?/, '');
      return join('Qwen', takeVersion(rest));
    },
  },
  {
    id: 'moonshot', label: 'Moonshot (Kimi)',
    test: b => /^kimi/.test(b),
    family: b => join('Kimi K', takeVersion(after(b, /^kimi-?k/))).replace('K ', 'K'),
  },
  {
    id: 'minimax', label: 'MiniMax',
    test: b => /^minimax|^m\d/.test(b),
    family: b => join('MiniMax M', takeVersion(after(b, /^(minimax-?)?m/))).replace('M ', 'M'),
  },
  {
    id: 'meta', label: 'Meta',
    test: b => /^llama|muse-glimmer/.test(b),
    family: b => (/muse-glimmer/.test(b) ? 'Muse Glimmer' : join('Llama', takeVersion(after(b, /^llama-?/)))),
  },
  {
    id: 'nvidia', label: 'NVIDIA',
    test: b => /^nemotron/.test(b),
    family: b => join('Nemotron', takeVersion(after(b, /^nemotron-?/))),
  },
  {
    id: 'mistral', label: 'Mistral',
    test: b => /^mistral/.test(b),
    family: b => {
      const m = /(large|small|nemo|medium)/.exec(b);
      if (!m) return 'Mistral';
      const tier = m[1][0].toUpperCase() + m[1].slice(1);
      return join('Mistral', tier, takeVersion(after(b, new RegExp(`${m[1]}-`))));
    },
  },
  { id: 'bfl', label: 'Black Forest (FLUX)', test: b => /^flux/.test(b), family: b => join('FLUX', takeVersion(after(b, /^flux-?/))) },
  { id: 'bytedance', label: 'ByteDance', test: b => /^seedream|^seed-/.test(b), family: b => (/^seedream/.test(b) ? 'Seedream' : 'Seed') },
  { id: 'venice', label: 'Venice', test: b => /^venice|^lustify/.test(b), family: b => (/^lustify/.test(b) ? 'Lustify' : 'Venice') },
  { id: 'tencent', label: 'Tencent', test: b => /^hunyuan|^hy\d/.test(b), family: () => 'Hunyuan' },
  { id: 'stepfun', label: 'StepFun', test: b => /^step-/.test(b), family: b => join('Step', takeVersion(after(b, /^step-/))) },
  { id: 'nous', label: 'Nous Research', test: b => /^hermes/.test(b), family: () => 'Hermes' },
  { id: 'aion', label: 'AionLabs', test: b => /^aion/.test(b), family: b => join('Aion', takeVersion(after(b, /^aion-?/))) },
  { id: 'xiaomi', label: 'Xiaomi', test: b => /^mimo/.test(b), family: () => 'MiMo' },
  { id: 'inception', label: 'Inception', test: b => /^mercury/.test(b), family: () => 'Mercury' },
  { id: 'recraft', label: 'Recraft', test: b => /^recraft/.test(b), family: () => 'Recraft' },
  { id: 'ideogram', label: 'Ideogram', test: b => /^ideogram/.test(b), family: () => 'Ideogram' },
  { id: 'krea', label: 'Krea', test: b => /^krea/.test(b), family: () => 'Krea' },
  { id: 'luma', label: 'Luma', test: b => /^luma/.test(b), family: () => 'Luma' },
];

const OTHER = { id: 'other', label: 'Other' };

// ---------------------------------------------------------------------------
// Canonical model identity
// ---------------------------------------------------------------------------
// The same model is listed under different names by different sellers:
// `claude-opus-4-8` vs `claude-opus-4.8`, `gpt-56-sol` vs `gpt-5.6-sol` vs
// `openai-gpt-56-sol`. Left unmerged, each spelling becomes its own row, so
// the "5 cheapest sellers" for a model is computed over only the subset of
// sellers that happened to spell it the same way — i.e. the headline answer
// on this page would be wrong.
//
// canonicalModel() collapses *formatting* differences only. It is deliberately
// conservative: it normalizes separators, org prefixes and release datestamps,
// and NOTHING else. Meaningful suffixes stay part of the key, so
// `claude-opus-4-8` and `claude-opus-4-8-fast` remain two different models,
// as do `-pro`, `-mini`, `-flash`, `-edit`, quantization and parameter counts.
// Over-merging would put two genuinely different products in one price
// comparison, which is a worse failure than leaving a duplicate row.
//
// REMOVED (2026-09-17): this file used to export `canonicalKey()` and
// `pickCanonicalLabel()` — a local, hand-rolled attempt at model identity.
// They are gone on purpose. Model identity now comes from the protocol SDK:
// the backend computes `canonicalKey` / `displayName` per service row with
// @antseed/node's `canonicalModelKey()` / `preferredModelDisplayName()`, the
// same functions the buyer node uses to resolve a requested model to a
// seller. Checked against live data, the local version over-merged 42 pairs
// the protocol keeps distinct — including `deepseek-v4-flash` vs
// `deepseek-v4-flash-0731` and `e2ee-` TEE builds, which carry different
// prices and are therefore different products. Do not reintroduce a local
// canonicalizer here; if grouping looks wrong, fix it upstream in
// packages/node/src/model-identity.ts so routing and display stay in sync.
//
// What remains in this file is only the presentational company -> family
// taxonomy used for the filter chips, which has no protocol meaning.

/** Classify one raw model name into { companyId, companyLabel, family }. */
export function classifyModel(rawName) {
  const raw = String(rawName || '');
  const base = stripPrefixes(raw.toLowerCase().trim());
  for (const rule of RULES) {
    if (rule.test(base)) {
      const family = (rule.family(base) || '').trim();
      return {
        companyId: rule.id,
        companyLabel: rule.label,
        // Fall back to the raw name rather than inventing a family label.
        family: family || raw,
      };
    }
  }
  return { companyId: OTHER.id, companyLabel: OTHER.label, family: raw };
}

/**
 * Build the two-level filter tree from the model groups actually present.
 * Companies and families are sorted by how many models they carry (desc),
 * so the brands a user is most likely to want sit leftmost. "Other" is
 * always pinned last regardless of size.
 */
export function buildModelTaxonomy(modelNames) {
  const companies = new Map();
  for (const name of modelNames) {
    const { companyId, companyLabel, family } = classifyModel(name);
    if (!companies.has(companyId)) {
      companies.set(companyId, { id: companyId, label: companyLabel, families: new Map(), count: 0 });
    }
    const c = companies.get(companyId);
    c.count++;
    if (!c.families.has(family)) c.families.set(family, { label: family, models: [] });
    c.families.get(family).models.push(name);
  }
  return [...companies.values()]
    .map(c => ({
      id: c.id,
      label: c.label,
      count: c.count,
      families: [...c.families.values()]
        .map(f => ({ label: f.label, count: f.models.length, models: f.models }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => {
      if (a.id === OTHER.id) return 1;
      if (b.id === OTHER.id) return -1;
      return b.count - a.count || a.label.localeCompare(b.label);
    });
}
