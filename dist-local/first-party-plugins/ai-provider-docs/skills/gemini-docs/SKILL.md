---
name: gemini-docs
description: Build against the Google Gemini API — generateContent, function calling, grounding with Google Search, context caching, and multimodal input. Use when writing or debugging code that calls Gemini, or answering Gemini API questions.
---

# Google Gemini API

## Sources (never answer version/pricing questions from memory)

- API docs: https://ai.google.dev/gemini-api/docs
- Models list: https://ai.google.dev/gemini-api/docs/models
- API reference: https://ai.google.dev/api

Google does not publish an llms.txt (verified absent as of mid-2026) — fetch
the docs pages directly. If a cached doc pack exists in this skill's
directory, grep it first.

## Orientation

- Two distinct surfaces exist: the **Gemini Developer API** (API key from
  AI Studio, `generativelanguage.googleapis.com`) and **Vertex AI** (GCP
  auth, different endpoints/SDK). Confirm which one the project uses before
  suggesting code — mixing their SDKs is the most common integration error.
- Current SDK is `google-genai` (Python) / `@google/genai` (JS); older
  `google-generativeai` code is deprecated-generation and looks similar but
  differs in client setup.
- Model names and free-tier quotas change frequently; check the models page.

## Footguns worth knowing

- `generateContent` roles are `user`/`model` (not `assistant`); system
  instructions go in a dedicated `systemInstruction` field.
- Function calling: declarations use an OpenAPI-subset schema; the model
  returns `functionCall` parts you must answer with `functionResponse` parts.
- Multimodal: files above the inline-size limit must go through the Files
  API first; inline base64 for large media silently degrades or 400s.
- Safety settings block responses with a `finishReason` of `SAFETY` — check
  finish reasons before assuming an empty response is a bug.
- Context caching has a minimum token threshold and per-hour storage billing;
  it pays off for repeated large prefixes only.
