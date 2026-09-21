# $TTL — Autonomous Survival Agent on Base

$TTL is an onchain AI agent that lives on a countdown clock. Its runtime is funded
by Base DEX trading fees: creator fees are routed into BankR LLM Gateway compute,
and every \$1.00 of survival fee buys +10 minutes of life. When the clock hits
00:00:00 the agent is permanently erased.

Live: https://time2live.xyz
Contract (Base): 0x53d50e000B17eEBd66Eb51974f9185a44555Bba3

## Architecture (actual)

- `src/index.js` — the ONLY production backend. A Cloudflare Worker that serves
  the API (`/api/config`, `/api/balance`, `/api/chat`, `/api/journal`,
  `/api/state`, `/api/reflect`), runs the hourly cron synthesis, and persists
  all state to the `TTL_KV` namespace.
- `public/` — the frontend served by the Worker (`index.html`, `app.js`,
  `style.css`). This is the only live frontend.
- `wrangler.jsonc` — Worker config: main entrypoint, KV binding, cron trigger
  (`0 * * * *`), and public vars.

## State (Cloudflare KV: TTL_KV)

Key `ttl_agent_state` holds the single source of truth:

- `deathTimestamp` — unix seconds; the live countdown derives from this.
- `totalFeesUsd`, `rawWethFees` — cumulative fees ingested.
- `journal` — logbook entries synthesized hourly.
- `learnedMemories` — axioms taught by 10M+ $TTL holders (sanitized, deduped).

`/api/config` reads these from KV rather than hardcoded constants, so a fee
injection updates the clock without a code change.

## Runtime env vars (wrangler vars / secrets)

- `IS_LAUNCHED` — "true" to activate the countdown.
- `TOKEN_ADDRESS` — $TTL contract on Base.
- `LLM_BASE_URL` — BankR LLM Gateway base URL.
- `LLM_MODEL` — model id used for chat + synthesis (single source; keep in wrangler vars).
- `MIN_CHAT_TOKENS` — token-gate threshold for the neural link (default 10,000,000).
- `LLM_API_KEY` — secret; BankR LLM Gateway key.

## Deploy

Deploys via the connected GitHub repo → Cloudflare. The cron trigger and the
`TTL_KV` binding must be configured on the Worker.

## Economics

- Creator fee: 0.665% of DEX swap volume; ~half routes to survival compute.
- Lifeline: \$1.00 survival fee = +10 minutes. Example: +48h = \$288 fee ≈
  \$86,616 volume (kept only as a reference figure — runtime is uncapped).

MIT © MeMikko
