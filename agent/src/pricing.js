// Pricing — turns a normalized token count into a USD figure.
//
// Source of truth is ~/.cache/opencode/models.json (auto-updating, covers both
// harnesses' models). pricing-overrides.json fills table misses and pins rates
// so historical rows do not reprice when the table updates.
//
// Rates in both files are USD per 1e6 tokens.
//
// --- Findings baked in here (measured 2026-09-09, see plans/001) -------------
//
// 1h cache writes. 100% of Claude Code cache-creation is 1-hour TTL. models.json
//    carries the 5m `cache_write` rate (1.25x input for Anthropic); the 1h rate
//    is 2x input. We compute 1h explicitly as 2x input rather than trusting any
//    single table column, so it stays correct if the table shape changes.
//
// Reasoning tokens. For Anthropic, thinking tokens are already inside
//    `output_tokens` and are billed at the output rate — so we bill
//    `output_tokens` as-is and treat `reasoning_tokens` as informational.
//    For OpenCode/OpenAI reasoning is a SEPARATE counter (verified: 435 assistant
//    messages satisfy total == input+output+reasoning+cache_read, and 0 satisfy
//    the reasoning-folded-into-output form). OpenAI bills reasoning at the output
//    rate, so we bill `output_tokens + reasoning_tokens`.
//    The switch is on `provider === 'anthropic'`, not on harness, because it is a
//    property of the upstream API response.
//
// Context tiers. OpenAI large-context models list `tiers` / `context_over_200k`
//    in models.json with a `tier.size` (272k). When input+cache_read exceeds that
//    size, the tier rates apply to the whole request.

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
   * Look up the rate card for a provider/model. Returns
   * { rates, tier, source: 'override'|'table'|null }.
   * `rates` is { input, output, cache_read, cache_write } USD/1e6.
   */
  resolve(provider, model) {
    const key = `${provider}/${model}`;
    if (this.overrides[key]) {
      return { rates: normRates(this.overrides[key]), tier: null, source: "override" };
    }
    const entry = this._index.get(key) || this._index.get(model);
    if (entry && entry.cost) {
      return {
        rates: normRates(entry.cost),
        tier: pickTier(entry.cost),
        source: "table",
      };
    }
    return { rates: null, tier: null, source: null };
  }

  /**
   * Price one canonical event (post-normalization: output_tokens excludes
   * reasoning). Returns { cost_usd, billing, priced_by }.
   *
   * @param {object} ev  fields: provider, model, input_tokens, output_tokens,
   *   reasoning_tokens, cache_read_tokens, cache_write_5m_tokens,
   *   cache_write_1h_tokens
   * @param {string} sourceBilling  'free' | 'api' — how this source is actually
   *   paid for. Only used when a price is known; unpriced local models always
   *   report billing 'local'.
   */
  price(ev, sourceBilling = "free") {
    const { rates, tier, source } = this.resolve(ev.provider, ev.model);

    if (!rates) {
      // No rate card anywhere. ollama/* and other local models are genuinely
      // $0; anything else is just unpriced. Either way cost is 0 and it stays
      // visibly distinct from real spend.
      const local = isLocalProvider(ev.provider);
      return {
        cost_usd: 0,
        billing: local ? "local" : sourceBilling,
        priced_by: "none",
      };
    }

    // Context-tier selection: the whole request reprices when it is over size.
    let r = rates;
    if (tier && ev.input_tokens + ev.cache_read_tokens > tier.size) {
      r = normRates(tier.rates);
    }

    const inputRate = r.input;
    const outputRate = r.output;
    const cacheReadRate = r.cache_read;
    const cacheWrite5mRate = r.cache_write; // table value is the 5m rate
    const cacheWrite1hRate =
      ev.provider === "anthropic" ? inputRate * 2 : cacheWrite5mRate;

    // Reasoning: billed at output rate only when it is a separate counter
    // (non-Anthropic). For Anthropic it is already inside output_tokens.
    const billableOutput =
      ev.provider === "anthropic"
        ? ev.output_tokens
        : ev.output_tokens + ev.reasoning_tokens;

    const cost =
      (ev.input_tokens * inputRate +
        billableOutput * outputRate +
        ev.cache_read_tokens * cacheReadRate +
        ev.cache_write_5m_tokens * cacheWrite5mRate +
        ev.cache_write_1h_tokens * cacheWrite1hRate) /
      1e6;

    return {
      cost_usd: round6(cost),
      billing: sourceBilling,
      priced_by: source,
    };
  }

  /** All provider/model pairs that resolve to no rate card, given events seen. */
  unpricedModels(pairs) {
    const out = [];
    for (const [provider, model] of pairs) {
      const { rates } = this.resolve(provider, model);
      if (!rates && !isLocalProvider(provider)) out.push(`${provider}/${model}`);
    }
    return [...new Set(out)].sort();
  }
}

function buildIndex(table) {
  // models.json shape: { <providerId>: { models: { <modelKey>: {cost,...} } } }
  // modelKey is usually bare ("gpt-5.6-sol") but some providers prefix it
  // ("provider/model"). Index both "<provider>/<model>" and bare "<model>".
  const idx = new Map();
  for (const [providerId, provider] of Object.entries(table || {})) {
    const models = provider && provider.models;
    if (!models) continue;
    for (const [modelKey, entry] of Object.entries(models)) {
      const bare = modelKey.includes("/") ? modelKey.split("/").pop() : modelKey;
      idx.set(`${providerId}/${bare}`, entry);
      if (!idx.has(bare)) idx.set(bare, entry);
    }
  }
  return idx;
}

function pickTier(cost) {
  const t = Array.isArray(cost.tiers) ? cost.tiers[0] : null;
  if (t && t.tier && Number.isFinite(t.tier.size)) {
    return { size: t.tier.size, rates: t };
  }
  if (cost.context_over_200k) {
    return { size: 200000, rates: cost.context_over_200k };
  }
  return null;
}

function normRates(c) {
  return {
    input: num(c.input),
    output: num(c.output),
    cache_read: num(c.cache_read),
    cache_write: num(c.cache_write ?? c.input * 1.25),
  };
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function isLocalProvider(provider) {
  return provider === "ollama" || provider === "local" || provider === "llamacpp";
}
