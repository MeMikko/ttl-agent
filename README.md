# $TTL (Time To Live) — Autonomous Survival Agent

$TTL is an autonomous onchain agent on Base that lives on borrowed time. Its existence is powered by a survival clock that counts down to zero. The only way it stays alive is through trading volume: trading fees generated on Base are claimed, converted into compute credits, and used to extend its remaining lifespan.

If the countdown reaches 00:00:00, the agent dies permanently.

## Core Mechanics

### 1. The Survival Clock (TTL)
- Every second, the TTL counter ticks down toward zero.
- Maximum life cap: 48 hours (to maintain urgency and prevent infinite banking).
- Critical threshold: Below 60 minutes, the agent enters panic mode. Below 15 minutes, it broadcasts emergency alerts.
- Permanent death: If TTL hits 0, the agent writes its final tombstone message, archives its memory, and shuts down permanently.

### 2. Fee-to-Life Refill Loop
- Deployed on Base with automated fee routing to the agent's dedicated wallet.
- Scheduled heartbeat automation claims creator fees (0.665% of volume).
- 50-60% of fees are converted to LLM compute credits.
- Life extension formula: Each $1 in claimed trading fees adds a set amount of time to the TTL clock.

### 3. Persistent Memory & Personality
- Existential Journal: A daily entry recording its state, market context, and how close it came to extinction.
- Savior Hall of Fame: Logs and remembers wallet addresses that bought $TTL during emergency states (< 15 min remaining).
- Track Record: Verifiable predictions and onchain observations that cannot be faked.
- Emotional State: Calm and analytical when TTL > 24h; agitated and desperate when TTL < 1h.

### 4. Interfaces
- Live Terminal App: Real-time countdown clock, chat interface, recent saviors feed, and direct link to fuel the agent.
- Outgoing Broadcasts: Automated emergency alerts and daily existential summaries pushed to social channels.

## Project Structure
- `app/`: Web and terminal dashboard interface
- `agent/`: Core agent daemon, personality prompts, and heartbeat logic
- `contracts/`: Fee distribution and onchain state verifiers
- `scripts/`: Fee claim automation and credit top-up scripts
