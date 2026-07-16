---
name: openai-docs
description: Build against the OpenAI API — Responses API, Chat Completions, function calling, structured outputs, embeddings, and model selection. Use when writing or debugging code that calls OpenAI, or answering OpenAI API questions.
---

# OpenAI API

## Sources (never answer version/pricing questions from memory)

- Docs index for agents: https://developers.openai.com/llms.txt
  (API-specific: https://developers.openai.com/api/llms.txt)
- Platform docs: https://platform.openai.com/docs
- Cookbook: https://cookbook.openai.com

If a cached `llms.txt` file exists in this skill's directory (downloaded doc
pack), grep it to locate the right page, then fetch that page. Otherwise
fetch the llms.txt URL first.

## Orientation

- **Responses API is the current primary API** (`/v1/responses`); Chat
  Completions (`/v1/chat/completions`) remains supported and is what most
  older code uses. Don't migrate code between them casually — tool/function
  schemas and streaming event shapes differ.
- Model names, context windows, and pricing change frequently — always check
  the docs' models page for what's current before recommending a model.
- Structured outputs: prefer `response_format`/`text.format` with a strict
  JSON schema over "please reply in JSON" prompting.

## Footguns worth knowing

- `max_tokens` vs `max_completion_tokens` vs `max_output_tokens` differ
  across API generations and model families; using the wrong one 400s.
- Streaming: Responses API emits typed events, Chat Completions emits deltas —
  parsers are not interchangeable.
- Function calling: the model can return multiple tool calls in one turn;
  handle the array, and always send tool results back with matching call ids.
- Rate limits are per-org and per-model tier; 429 handling with exponential
  backoff is required, not optional.
- API keys belong in environment variables (`OPENAI_API_KEY`); never embed in
  client-side code.
