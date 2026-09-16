// Pricing — turns a normalized token count into a USD figure, either at the
// model's own rates (`price`) or at some other model's rates (`repriceEvent`).
//
// Source of truth is ~/.cache/opencode/models.json (auto-updating, covers both
// harnesses). pricing-overrides.json fills table misses and pins rates so
// historical rows do not reprice when the table updates.
//
// Rates in both files are USD per 1e6 tokens.
//
// --- Semantics (see plans/002-counterfactual-repricing.md) -------------------
//
// Billable output. `output_tokens` EXCLUDES reasoning for every harness — the
//   extractors normalize it out (sources/claude-code.js subtracts
//   thinking_tokens; OpenCode reports reasoning separately already). So billable
//   output is uniformly `output_tokens + reasoning_tokens`, with NO per-provider
//   special case. An earlier version kept an `provider === 'anthropic'` branch
//   here from before that normalization existed, which silently billed Anthropic
//   thinking tokens at $0 — $25.41 across the history measured 2026-09-09.
//
// Cache fallbacks. A rate card that omits `cache_read` is a model with NO prompt
//   caching (156 of 358 OpenRouter models). Its cache-read tokens must bill at
//   the INPUT rate, not free — treating a missing field as 0 understated such a
//   target by ~10x on this cache-heavy workload. Likewise a card with
//   `cache_read` but no `cache_write` (297 of 358) bills cache writes at the
//   input rate rather than an invented multiplier. The resulting classification
//   is reported as `cache_model`: 'full' | 'read-only' | 'none'.
//
// Anthropic 1h writes. Anthropic's 1-hour cache write costs 2x input, while the
//   table carries only the 5-minute rate. That rule is ANTHROPIC-ONLY: when
//   repricing onto any other provider, 1h and 5m writes both use that target's
//   cache-write rate.
//
// Context tiers. Large-context models list `tiers` (and/or `context_over_200k`).
//   Some have MORE THAN ONE tier (e.g. qwen3-coder-plus at 32k and 128k), so we
//   select the HIGHEST tier whose size is exceeded, not `tiers[0]`.

import { readFile } from "node:fs/promises";
import { expandHome } from "./config.js";

const DEFAULT_MODELS_JSON = "~/.cache/opencode/models.json";

export async function loadPricing({ modelsJsonPath, overridesPath } = {}) {
  const modelsPath = expandHome(modelsJsonPath || DEFAULT_MODELS_JSON);
  const ovPath = expandHome(
    overridesPath || new URL("../pricing-overrides.json", import.meta.url).pathname,
  );

  let table = {};
  let tableError = null;
  try {
    table = JSON.parse(await readFile(modelsPath, "utf8"));
  } catch (err) {
    tableError = err;
  }

  let overrides = {};
  try {
    const raw = JSON.parse(await readFile(ovPath, "utf8"));
    overrides = raw.overrides || {};
  } catch {
    // overrides are optional
  }

  return new Pricing(table, overrides, { modelsPath, tableError });
}

export class Pricing {
  constructor(table, overrides, meta = {}) {
    this.table = table || {};
    this.overrides = overrides || {};
    this.meta = meta;
    this._index = buildIndex(this.table);
  }

  /**
   * Look up a rate card. Returns { card, source } where source is
   * 'override' | 'table' | null, and card is
   * { base: Rates, tiers: [{ size, rates: Rates }] } or null.
   * Rates fields are numbers, except cache_read / cache_write which are null
   * when the model does not price them (meaning: no caching of that kind).
   */
  resolve(provider, model) {
    const key = `${provider}/${model}`;
    if (this.overrides[key]) {
      return { card: toCard(this.overrides[key]), source: "override" };
    }
    // Provider-scoped lookups ONLY. A global bare-name fallback used to live
    // here and silently matched across providers: ollama/qwen3.6:27b resolved
    // to an unrelated "pendra" entry that happened to share the bare name,
    // which reclassified 26 local events as billable. In a 7,800-model table,
    // bare names are not unique and must never be trusted on their own.
    const entry =
      this._index.get(key) || this._index.get(`${provider}/${bareOf(model)}`);
    if (entry && entry.cost) {
      return { card: toCard(entry.cost), source: "table" };
    }
    return { card: null, source: null };
  }

  /**
   * Resolve a fully-qualified scenario key such as
   * "openrouter/qwen/qwen3.7-flash" or "tokengo/z-ai/glm-5.2" — the first
   * segment is the provider, the remainder is the model id.
   */
  resolveKey(fullKey) {
    const slash = String(fullKey).indexOf("/");
    if (slash === -1) return { card: null, source: null, provider: null, model: fullKey };
    const provider = fullKey.slice(0, slash);
    const model = fullKey.slice(slash + 1);
    return { ...this.resolve(provider, model), provider, model };
  }

  /**
   * Price an event at its OWN model's rates.
   * @param {string} sourceBilling 'free' | 'api' — how this source is actually
   *   paid for. Unpriced local models always report billing 'local'.
   */
  price(ev, sourceBilling = "free") {
    // Local inference runs on hardware you already own: it is $0 by definition,
    // and that must not depend on whether the price table happens to contain a
    // matching name. Checked BEFORE resolve() so no rate card — coincidental or
    // deliberate — can ever attribute spend to it.
    if (isLocalProvider(ev.provider)) {
      return {
        cost_usd: 0,
        billing: "local",
        priced_by: "none",
        cache_model: "none",
        ...nullRates(),
      };
    }

    const { card, source } = this.resolve(ev.provider, ev.model);

    if (!card) {
      return {
        cost_usd: 0,
        billing: sourceBilling,
        priced_by: "none",
        cache_model: "none",
        ...nullRates(),
      };
    }

    const computed = computeCost(ev, card, ev.provider);
    return { ...computed, billing: sourceBilling, priced_by: source };
  }

  /**
   * Reprice an event at ANOTHER model's rates — the counterfactual.
   * Returns priced_by 'none' with cost 0 when the target has no rate card; the
   * caller must exclude those rather than reporting them as free.
   */
  repriceEvent(ev, targetKey) {
    const { card, source, provider } = this.resolveKey(targetKey);
    if (!card) {
      return {
        cost_usd: 0,
        cache_model: "none",
        priced_by: "none",
        scenario: targetKey,
        ...nullRates(),
      };
    }
    const computed = computeCost(ev, card, provider);
    return { ...computed, priced_by: source, scenario: targetKey };
  }

  /** All provider/model pairs that resolve to no rate card. */
  unpricedModels(pairs) {
    const out = [];
    for (const [provider, model] of pairs) {
      const { card } = this.resolve(provider, model);
      if (!card && !isLocalProvider(provider)) out.push(`${provider}/${model}`);
    }
    return [...new Set(out)].sort();
  }

  /** Classify a target's caching support without pricing anything. */
  cacheModelOf(targetKey) {
    const { card } = this.resolveKey(targetKey);
    return card ? cacheModelOf(card.base) : null;
  }
}

// --- costing ---------------------------------------------------------------

/**
 * @param {object} ev             canonical token counts
 * @param {object} card           { base, tiers }
 * @param {string} targetProvider provider the rates belong to (governs the
 *                                Anthropic 1h rule)
 */
function computeCost(ev, card, targetProvider) {
  const contextTokens = ev.input_tokens + ev.cache_read_tokens;
  const { rates, tierSize } = selectTier(card, contextTokens);

  const cache_model = cacheModelOf(rates);

  // Fallbacks: a model that does not price cached tokens charges them as input.
  const cacheReadRate = rates.cache_read ?? rates.input;
  const cacheWriteRate = rates.cache_write ?? rates.input;
  const cacheWrite1hRate =
    targetProvider === "anthropic" && rates.cache_write != null
      ? rates.input * 2
      : cacheWriteRate;

  const billableOutput = ev.output_tokens + ev.reasoning_tokens;

  const cost =
    (ev.input_tokens * rates.input +
      billableOutput * rates.output +
      ev.cache_read_tokens * cacheReadRate +
      ev.cache_write_5m_tokens * cacheWriteRate +
      ev.cache_write_1h_tokens * cacheWrite1hRate) /
    1e6;

  // The APPLIED rates are returned, not the card as written: tier selection and
  // the cache fallbacks above mean they routinely differ, and only the applied
  // values can reproduce cost_usd (see plans/003).
  return {
    cost_usd: round6(cost),
    cache_model,
    tier_applied: tierSize,
    rate_input: rates.input,
    rate_output: rates.output,
    rate_cache_read: cacheReadRate,
    rate_cache_write_5m: cacheWriteRate,
    rate_cache_write_1h: cacheWrite1hRate,
  };
}

/**
 * The "rates unknown" shape. Deliberately null rather than 0 — a row priced
 * with no rate card has UNKNOWN rates, and zeros would be a lie that silently
 * satisfies the usage_cost_audit reconciliation.
 */
function nullRates() {
  return {
    tier_applied: null,
    rate_input: null,
    rate_output: null,
    rate_cache_read: null,
    rate_cache_write_5m: null,
    rate_cache_write_1h: null,
  };
}

/** Highest tier whose size is exceeded; base rates when none apply. */
function selectTier(card, contextTokens) {
  let best = null;
  for (const t of card.tiers) {
    if (contextTokens > t.size && (!best || t.size > best.size)) best = t;
  }
  return best
    ? { rates: best.rates, tierSize: best.size }
    : { rates: card.base, tierSize: null };
}

function cacheModelOf(rates) {
  if (rates.cache_read == null) return "none";
  if (rates.cache_write == null) return "read-only";
  return "full";
}

// --- table plumbing --------------------------------------------------------

function buildIndex(table) {
  // models.json shape: { <providerId>: { models: { <modelKey>: {cost,...} } } }
  // modelKey is bare ("gpt-5.6-sol") for some providers and namespaced
  // ("qwen/qwen3.7-flash") for aggregators, so index both forms — but ALWAYS
  // scoped to the provider. Unscoped bare names are not unique across 7,800
  // models and caused a cross-provider mismatch when they were indexed.
  const idx = new Map();
  for (const [providerId, provider] of Object.entries(table || {})) {
    const models = provider && provider.models;
    if (!models) continue;
    for (const [modelKey, entry] of Object.entries(models)) {
      const bare = bareOf(modelKey);
      idx.set(`${providerId}/${modelKey}`, entry);
      if (!idx.has(`${providerId}/${bare}`)) idx.set(`${providerId}/${bare}`, entry);
    }
  }
  return idx;
}

function toCard(cost) {
  const tiers = [];
  if (Array.isArray(cost.tiers)) {
    for (const t of cost.tiers) {
      const size = t?.tier?.size;
      if (Number.isFinite(size)) tiers.push({ size, rates: normRates(t) });
    }
  }
  if (!tiers.length && cost.context_over_200k) {
    tiers.push({ size: 200000, rates: normRates(cost.context_over_200k) });
  }
  return { base: normRates(cost), tiers };
}

/**
 * Note the deliberate asymmetry: input/output always coerce to a number, but
 * cache_read / cache_write stay NULL when absent. Absence is meaningful — it
 * says the model has no such cache tier — and collapsing it to 0 would price
 * those tokens as free.
 */
function normRates(c) {
  return {
    input: num(c.input),
    output: num(c.output),
    cache_read: c.cache_read == null ? null : num(c.cache_read),
    cache_write: c.cache_write == null ? null : num(c.cache_write),
  };
}

function bareOf(key) {
  return String(key).includes("/") ? String(key).split("/").pop() : String(key);
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// Local inference runners. Membership here is a claim about WHERE the tokens
// were computed, not about whether the table happens to price the model: these
// run on hardware you already own, so they are $0 by definition and must never
// be attributed spend (see price(), which checks this before resolve()).
// lmstudio was missing until 2026-09-17 — its models fell through to
// priced_by='none' and were reported by `doctor` as a pricing gap to fill,
// which would have been exactly the wrong fix.
const LOCAL_PROVIDERS = new Set(["ollama", "local", "llamacpp", "lmstudio"]);

function isLocalProvider(provider) {
  return LOCAL_PROVIDERS.has(provider);
}
