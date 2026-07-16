---
name: ai-gateway-docs
description: Use Vercel AI Gateway and the AI SDK — one endpoint for many model providers, provider routing/fallbacks, usage/cost tracking, and streaming UI integration. Use when a project routes model calls through Vercel AI Gateway or uses the ai-sdk.
---

# Vercel AI Gateway & AI SDK

## Sources (never answer version/pricing questions from memory)

- Vercel docs index for agents: https://vercel.com/llms.txt
  (AI Gateway section: https://vercel.com/docs/ai-gateway)
- AI SDK docs index: https://ai-sdk.dev/llms.txt
- Official Vercel skills pack (MIT): https://github.com/vercel-labs/agent-skills

If a cached doc pack exists in this skill's directory, grep it first.

## Orientation

- **AI Gateway** is a hosted proxy: one API key + one base URL
  (`https://ai-gateway.vercel.sh/v1`, OpenAI-compatible) in front of many
  providers, with model strings like `provider/model` (e.g.
  `anthropic/claude-sonnet-5`, `openai/gpt-5`). It handles provider auth,
  fallbacks, and usage attribution.
- **AI SDK** (`ai` npm package) is the client framework: `generateText`,
  `streamText`, `generateObject`, tool definitions, and React hooks
  (`useChat`). It speaks to the Gateway natively (`model: "openai/gpt-5"`
  as a string) or to providers directly via `@ai-sdk/*` packages.
- These are separable: Gateway works with any OpenAI-compatible client; the
  SDK works without the Gateway. Establish which combination the project
  uses before editing.

## Footguns worth knowing

- Model availability, pricing markup, and provider routing rules live in the
  Gateway docs and change often — check before promising a model works.
- Streaming through the SDK's `useChat`/`streamText` uses its own data
  protocol between server route and client; mixing raw SSE parsing with SDK
  clients breaks — stay inside the SDK on both ends or neither.
- Tool calls with `streamText` need `maxSteps`/stopping conditions set or
  multi-step tool loops end after one step.
- Gateway auth: `AI_GATEWAY_API_KEY` (or OIDC on Vercel deployments);
  provider BYOK is configured in the dashboard, not in code.
