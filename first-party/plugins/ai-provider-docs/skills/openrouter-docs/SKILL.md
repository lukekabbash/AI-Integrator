---
name: openrouter-docs
description: Use the OpenRouter API — one OpenAI-compatible endpoint over hundreds of models, provider routing preferences, fallbacks, and per-model pricing. Use when a project calls OpenRouter or the user is comparing/routing across many models.
---

# OpenRouter

## Sources (never answer model/pricing questions from memory)

- Docs index for agents: https://openrouter.ai/docs/llms.txt
- Models & live pricing: https://openrouter.ai/models
  (machine-readable: https://openrouter.ai/api/v1/models)

If a cached `llms.txt` exists in this skill's directory, grep it first.

## Orientation

- OpenAI-compatible at `https://openrouter.ai/api/v1` with
  `OPENROUTER_API_KEY`; model ids are `vendor/model` (e.g.
  `anthropic/claude-sonnet-5`, `google/gemini-2.5-pro`). Most OpenAI SDK
  code ports by changing `base_url`.
- Routing is the differentiator: `provider` preferences (order, allow/deny,
  quantization filters), `models` array for fallback chains, and `:nitro` /
  `:floor` shortcuts for speed/price-optimized routing.
- Pricing differs per model and per underlying provider; query the models
  endpoint rather than quoting remembered numbers.

## Footguns worth knowing

- Feature support (tools, JSON mode, images, reasoning) varies per model —
  the models endpoint lists capabilities; check before sending tool schemas
  to a model that ignores them.
- Token accounting: usage is normalized by OpenRouter but context limits are
  the underlying model's; a fallback chain can silently switch to a model
  with a smaller context window mid-conversation.
- Optional attribution headers (`HTTP-Referer`, `X-Title`) affect app
  rankings/analytics only — not auth.
- BYOK vs credits change effective pricing and rate limits; don't assume the
  credit-pricing table applies to BYOK traffic.
