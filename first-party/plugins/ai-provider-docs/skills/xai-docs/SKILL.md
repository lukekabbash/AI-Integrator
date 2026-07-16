---
name: xai-docs
description: Build against the xAI API — Grok models, chat completions, function calling, live search, and image understanding. Use when writing or debugging code that calls xAI/Grok, or answering xAI API questions.
---

# xAI (Grok) API

## Sources (never answer version/pricing questions from memory)

- Docs index for agents: https://docs.x.ai/llms.txt
  (large — over 1 MB; grep/section it, never load it whole into context)
- Docs: https://docs.x.ai

If a cached `llms.txt` exists in this skill's directory (downloaded doc
pack), grep it to find the right section instead of fetching.

## Orientation

- The API is **OpenAI-compatible** at `https://api.x.ai/v1` — most OpenAI
  SDK code works by swapping `base_url` and using `XAI_API_KEY`. There is
  also an Anthropic-compatible surface; check the docs for current coverage.
- Compatibility is not identity: parameter support, model-specific features
  (live search, reasoning effort), and rate-limit shapes differ from OpenAI —
  verify any nonstandard parameter against the xAI docs, not OpenAI's.
- Grok model generations and pricing move fast; check the models page before
  recommending one.

## Footguns worth knowing

- Live/real-time search is an xAI-specific request feature — it isn't part
  of the OpenAI schema, so generic OpenAI client wrappers may strip it;
  pass it through extra-body/extra-params mechanisms.
- Reasoning models expose effort controls and return reasoning content
  differently from non-reasoning models; don't assume one response parser
  fits all Grok models.
- Rate limits are team- and model-specific; read them from response headers
  rather than hardcoding assumptions.
