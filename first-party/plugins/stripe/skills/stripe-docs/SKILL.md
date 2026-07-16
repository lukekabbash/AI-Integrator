---
name: stripe-docs
description: Integrate and debug Stripe payments — PaymentIntents, Checkout, webhooks and signature verification, subscriptions/billing, and test-mode workflows. Use when a project processes payments with Stripe.
---

# Stripe

## Canonical docs (fetch for version-specific answers)

- Docs index for agents: https://docs.stripe.com/llms.txt
- Payments quickstart: https://docs.stripe.com/payments
- Webhooks: https://docs.stripe.com/webhooks
- Billing/subscriptions: https://docs.stripe.com/billing
- API reference: https://docs.stripe.com/api

## CLI cheatsheet

`stripe listen --forward-to localhost:3000/webhook` (local webhook testing;
prints the signing secret) · `stripe trigger payment_intent.succeeded` ·
`stripe logs tail`. Test cards: `4242 4242 4242 4242` (success),
`4000 0000 0000 3220` (3DS challenge), `4000 0000 0000 9995` (decline).

## Footguns worth knowing

- **The webhook is the source of truth**, not the client redirect. Fulfill on
  `checkout.session.completed` / `payment_intent.succeeded`, verify the
  signature with the raw request body (framework body parsers that
  JSON-decode first break verification — the #1 integration bug), and make
  handlers idempotent (Stripe retries).
- Never log or persist full card data; the client SDK tokenizes so card
  numbers must never touch your server.
- Amounts are integer minor units (cents) — float math on money is a bug.
- Test and live modes have separate keys, data, and webhook secrets; a "works
  locally, broken in prod" report usually means live webhook endpoint or
  secret was never configured.
- Pin the API version in code; account-level version upgrades silently change
  response shapes.
- Subscriptions: handle `invoice.payment_failed` and the `past_due` state —
  building only the happy path guarantees support tickets.
