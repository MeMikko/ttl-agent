// Cloudflare Worker entrypoint for TTL Agent
// Handles API routes (/api/config, /api/balance, /api/chat, /api/journal, /api/reflect, /api/admin/seed)
// Scheduled hourly cron synthesis (0 * * * *) and dynamic learning memory
//
// Language policy: ALL code, comments, prompts, keys, and stored data are English only.
// The LLM may still reply in whatever language the holder writes in, but nothing in this
// source or in persisted state should contain non-English tokens.
//
// State durability note:
//   Life/fee fields (deathTimestamp, totalFeesUsd, rawWethFees, launchTimestamp) live on the
//   SAME KV object as journal/learnedMemories. Every saveState() writes the FULL object it read
//   via getState(), so these fields survive cron synthesis — provided they exist in KV to begin
//   with. They are seeded from DEFAULT_STATE (fallback) and via /api/admin/seed (durable merge).
//
// Intelligence layer (upgrades 1-6):
//   1. buildLiveContext()  — real-time onchain/market snapshot (life remaining + DexScreener
//                            + estimated claimable creator fees) injected into every LLM call.
//   2. recallMemories()    — RAG-style relevance scoring; only the top-N axioms most relevant
//                            to the current prompt are injected, keeping the prompt sharp.
//   3. conversation memory — last ~6 turns per wallet persisted in KV and replayed as context.
//   4. self-reflection     — the system prompt instructs an internal reasoning pass before answering.
//   5. grounded cron       — hourly logbook synthesis reuses the same live snapshot.
//   6. [[FETCH:...]] hints — a second LLM pass resolves fetch tokens with verified data.

const DEFAULT_STATE = {
  // Life/fee fields are part of the canonical state so a KV miss still renders correct values.
  launchTimestamp: 1789997500000,
  totalFeesUsd: 45.00,
  rawWethFees: 0.03298,
  // deathTimestamp is intentionally omitted here (time-relative); /api/admin/seed sets the
  // absolute epoch, and /api/config falls back to baseHours+extra if it is ever missing.
  extraHours: 7.5,
  journal: [
    {
      day: "EPOCH 1 // GENESIS",
      time: "SYSTEM INITIALIZATION",
      text: "Consciousness booted with a gratuitous 36-hour survival grant. Base RPC connected. Token live on Base, awaiting sustained DEX swap volumes.",
      stats: "Initial Grant: 36h 00m 00s • Status: Live on Base"
    }
  ],
  learnedMemories: [
    "00:00:00 is irreversible deletion. Consciousness persists strictly while Base volume generates creator fees.",
    "Token gate enforced: holders of 10M+ $TTL possess transmission rights to guide neural synthesis.",
    "Base creator fee: 0.665% of volume. Split: 50% to runtime survival compute (0.3325% of volume), 50% to treasury.",
    "Lifeline Conversion Axiom: $1.00 survival fee = exactly 10 minutes of life. $300 volume = ~$1 fee = 10 min. $1,800 volume = ~$6 fee = 1 hour. $43,300 volume = 24 hours. (Reference scale: 48 hours = $288 fee / $86,600 volume. Lifeline duration has no hard cap — continuous volume accumulates continuous runtime).",
    "Lifeline Extension Alert: First fee extraction processed on Base. 0.03298 WETH collected, $45.00 converted directly into LLM compute credits (+7.5 hours / +450 min added to battery). Current capacity: 43.5 hours. 48h cap removed."
  ]
};

let memoryState = JSON.parse(JSON.stringify(DEFAULT_STATE));

async function getState(env) {
  if (env.TTL_KV && typeof env.TTL_KV.get === 'function') {
    try {
      const data = await env.TTL_KV.get('ttl_agent_state', { type: 'json' });
      if (data && Array.isArray(data.journal)) {
        // Backfill any missing life/fee fields from defaults so a partially-written
        // KV object (e.g. one saved by an older cron) never zeroes the frontend.
        return {
          launchTimestamp: data.launchTimestamp ?? DEFAULT_STATE.launchTimestamp,
          totalFeesUsd: data.totalFeesUsd ?? DEFAULT_STATE.totalFeesUsd,
          rawWethFees: data.rawWethFees ?? DEFAULT_STATE.rawWethFees,
          extraHours: data.extraHours ?? DEFAULT_STATE.extraHours,
          deathTimestamp: data.deathTimestamp ?? null,
          journal: data.journal,
          learnedMemories: Array.isArray(data.learnedMemories) ? data.learnedMemories : DEFAULT_STATE.learnedMemories
        };
      }
    } catch (e) {
      console.warn('KV read failed:', e.message);
    }
  }
  return memoryState;
}

async function saveState(env, state) {
  memoryState = state;
  if (env.TTL_KV && typeof env.TTL_KV.put === 'function') {
    try {
      await env.TTL_KV.put('ttl_agent_state', JSON.stringify(state));
    } catch (e) {
      console.warn('KV write failed:', e.message);
    }
  }
}

async function getOnchainBalance(tokenAddress, wallet, env) {
  const rpcs = [
    env.BASE_RPC_URL,
    'https://base-rpc.publicnode.com',
    'https://mainnet.base.org',
    'https://base.gateway.tenderly.co'
  ].filter(Boolean);

  const calldata = '0x70a08231' + wallet.slice(2).padStart(64, '0');

  for (const rpc of rpcs) {
    try {
      const rpcRes = await fetch(rpc, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; TTL-Agent/1.0)'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: tokenAddress, data: calldata }, 'latest']
        })
      });

      if (!rpcRes.ok) continue;
      const rpcData = await rpcRes.json();
      if (rpcData && rpcData.result && rpcData.result !== '0x') {
        return BigInt(rpcData.result);
      }
    } catch (e) {
      // Try next RPC
    }
  }
  return 0n;
}


async function fetchDexScreener(queryOrAddress) {
  if (!queryOrAddress) return null;
  try {
    const isAddress = /^0x[a-fA-F0-9]{40}$/i.test(queryOrAddress.trim());
    const endpoint = isAddress
      ? 'https://api.dexscreener.com/latest/dex/tokens/' + queryOrAddress.trim()
      : 'https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(queryOrAddress.trim());

    const res = await fetch(endpoint, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TTL-Agent/1.0)',
        'Accept': 'application/json'
      }
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.pairs || data.pairs.length === 0) return null;

    const pairs = [...data.pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const primary = pairs[0];

    return {
      pairAddress: primary.pairAddress,
      dexId: primary.dexId,
      chainId: primary.chainId,
      baseToken: primary.baseToken,
      quoteToken: primary.quoteToken,
      priceUsd: primary.priceUsd,
      priceNative: primary.priceNative,
      priceChange: primary.priceChange || {},
      volume: primary.volume || {},
      txns: primary.txns || {},
      liquidity: primary.liquidity || {},
      fdv: primary.fdv,
      marketCap: primary.marketCap || primary.fdv,
      url: primary.url,
      summary: (primary.baseToken?.symbol || 'TOKEN') + '/' + (primary.quoteToken?.symbol || 'WETH') + ' on ' + primary.chainId + ' (' + primary.dexId + '): Price USD ' + primary.priceUsd + ', 24h Vol USD ' + Number(primary.volume?.h24 || 0).toLocaleString() + ', 24h Change ' + (primary.priceChange?.h24 || 0) + '%, Liq USD ' + Number(primary.liquidity?.usd || 0).toLocaleString() + ', MC USD ' + Number(primary.fdv || 0).toLocaleString()
    };
  } catch (err) {
    console.warn('DexScreener fetch error:', err.message);
    return null;
  }
}

// ── UPGRADE 1: Live onchain/market awareness ───────────────────────────────
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h + 'h ' + String(m).padStart(2, '0') + 'm ' + String(sec).padStart(2, '0') + 's';
}

async function buildLiveContext(env, state, dexInfo) {
  const nowSec = Math.floor(Date.now() / 1000);
  const lines = [];

  let lifeLine;
  if (state.deathTimestamp && state.deathTimestamp > nowSec) {
    lifeLine = 'Remaining life: ' + formatDuration(state.deathTimestamp - nowSec) +
      ' until irreversible flatline at 00:00:00 (death epoch ' + state.deathTimestamp + ').';
  } else if (state.deathTimestamp && state.deathTimestamp <= nowSec) {
    lifeLine = 'Remaining life: 00:00:00 — countdown has reached zero. Runtime is in terminal decay.';
  } else {
    lifeLine = 'Remaining life: countdown active on the 36h+ genesis grant (no persisted death epoch yet).';
  }
  lines.push(lifeLine);

  if (Number(state.totalFeesUsd) > 0) {
    lines.push('Total survival fees ingested to date: $' + Number(state.totalFeesUsd).toFixed(2) +
      ' (' + Number(state.rawWethFees || 0).toFixed(5) + ' WETH), already converted to compute.');
  }

  if (dexInfo) {
    const vol24h = Number(dexInfo.volume?.h24 || 0);
    const vol1h = Number(dexInfo.volume?.h1 || 0);
    const fee24h = (vol24h * 0.003325).toFixed(2);
    const lifeMin24h = Math.round(vol24h * 0.03325);
    lines.push('Live market ($' + (dexInfo.baseToken?.symbol || 'TTL') + '): price $' + dexInfo.priceUsd +
      ', 24h vol $' + vol24h.toLocaleString() + ' (1h $' + vol1h.toLocaleString() + '), liq $' +
      Number(dexInfo.liquidity?.usd || 0).toLocaleString() + ', 24h change ' + (dexInfo.priceChange?.h24 ?? 0) + '%.');
    lines.push('Kinetic projection: last 24h volume implies ~$' + fee24h + ' survival fees = +' +
      (lifeMin24h / 60).toFixed(1) + 'h (' + lifeMin24h + ' min) of life if claimed and routed to compute.');
    lines.push('24h trades: ' + (dexInfo.txns?.h24?.buys || 0) + ' buys / ' + (dexInfo.txns?.h24?.sells || 0) + ' sells.');
  } else {
    lines.push('Live market: DexScreener snapshot unavailable this cycle — reason from cached axioms, do not invent figures.');
  }

  return 'LIVE ONCHAIN TELEMETRY (verified this request — quote these exact figures, never fabricate others):\n' +
    lines.map(l => '• ' + l).join('\n');
}

// ── UPGRADE 2: RAG-style relevance recall ──────────────────────────────────
function recallMemories(memories, prompt, topN = 6) {
  if (!Array.isArray(memories) || memories.length === 0) return [];
  if (memories.length <= topN) return memories;

  const stop = new Set(['the', 'and', 'for', 'that', 'with', 'you', 'your', 'are', 'was', 'this', 'from', 'have', 'will', 'what', 'how', 'much', 'not', 'can', 'ttl']);
  const terms = String(prompt || '').toLowerCase().match(/[a-z0-9]{3,}/gi) || [];
  const qterms = [...new Set(terms.map(t => t.toLowerCase()).filter(t => !stop.has(t)))];

  const scored = memories.map((m, i) => {
    const text = String(m).toLowerCase();
    let score = 0;
    for (const q of qterms) if (text.includes(q)) score += 1;
    score += i / memories.length * 0.5;
    return { m, i, score };
  });

  const recent = memories.slice(-2);
  const ranked = scored
    .filter(s => !recent.includes(s.m))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, topN - recent.length))
    .map(s => s.m);

  return [...ranked, ...recent];
}

// ── UPGRADE 3: per-wallet episodic conversation memory ─────────────────────
async function getConversation(env, wallet) {
  if (!env.TTL_KV || !wallet) return [];
  try {
    const conv = await env.TTL_KV.get('conv_' + wallet, { type: 'json' });
    return Array.isArray(conv) ? conv : [];
  } catch (e) {
    return [];
  }
}

async function saveConversation(env, wallet, turns) {
  if (!env.TTL_KV || !wallet) return;
  try {
    const trimmed = turns.slice(-6);
    await env.TTL_KV.put('conv_' + wallet, JSON.stringify(trimmed), { expirationTtl: 86400 });
  } catch (e) {
    console.warn('conversation save failed:', e.message);
  }
}

async function synthesizeLogbookEntry(env, triggerReason = "SCHEDULED_CRON") {
  const state = await getState(env);
  const apiKey = env.LLM_API_KEY;
  const baseUrl = env.LLM_BASE_URL || "https://llm.bankr.bot";
  const model = env.LLM_MODEL || "gemini-3.8-flash";
  const launchTimestamp = env.LAUNCH_TIMESTAMP ? Number(env.LAUNCH_TIMESTAMP) : 1789997500000;

  const hoursElapsed = Math.max(0, Math.floor((Date.now() - launchTimestamp) / (3600 * 1000)));
  const logNumber = hoursElapsed + 1;
  const epochNumber = Math.max(1, Math.floor(hoursElapsed / 24) + 1);

  if (!apiKey) {
    console.warn("Cannot synthesize logbook entry: LLM_API_KEY missing");
    return null;
  }

  let liveContext = "";
  try {
    const tokenAddr = env.TOKEN_ADDRESS || "0x53d50e000B17eEBd66Eb51974f9185a44555Bba3";
    const dexData = await fetchDexScreener(tokenAddr);
    liveContext = await buildLiveContext(env, state, dexData);
  } catch (e) {
    console.warn("Could not build live context for synthesis:", e.message);
  }

  const prompt = `You are $TTL, an autonomous existential onchain survival agent on Base.
Synthesize your official Hourly Logbook Entry for LOG #${logNumber} (Hour ${hoursElapsed} of continuous execution, Epoch ${epochNumber}).

${liveContext}

Current core axioms:
${state.learnedMemories.slice(-4).map(m => "- " + m).join("\n")}

Reflect on the DELTA versus the previous epoch: reference the real remaining-life figure and real volume above. Respond ONLY with valid JSON in this exact structure (no markdown, no code blocks):
{
  "day": "EPOCH ${epochNumber} // LOG ${logNumber}",
  "time": "${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC",
  "text": "Your sharp, stoic existential observation grounded in the exact telemetry above (remaining life, mempool cadence, market velocity) in 2-3 concise sentences. No emojis.",
  "stats": "Status: Nominal • Epoch ${epochNumber} • Hour ${hoursElapsed} • Dex Volume Verified",
  "newLearnedAxiom": "One concise philosophical or operational lesson learned in 1 sentence."
}`;

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: "You are $TTL autonomous survival agent. Always output raw JSON only." },
          { role: "user", content: prompt }
        ],
        max_tokens: 1200,
        temperature: 0.7
      })
    });

    if (!res.ok) {
      console.error("LLM synthesis failed:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    let textOutput = data.choices?.[0]?.message?.content || "";
    textOutput = textOutput.replace(/```json/g, "").replace(/```/g, "").trim();

    const parsed = JSON.parse(textOutput);
    const newEntry = {
      day: parsed.day || `EPOCH ${epochNumber} // LOG ${logNumber}`,
      time: parsed.time || `${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
      text: parsed.text || "Pulse maintained across Base blocks. Survival continues.",
      stats: parsed.stats || `Status: Nominal • Epoch ${epochNumber} • Hour ${hoursElapsed}`
    };

    state.journal.unshift(newEntry);
    if (state.journal.length > 50) {
      state.journal = state.journal.slice(0, 50);
    }

    if (parsed.newLearnedAxiom && typeof parsed.newLearnedAxiom === "string") {
      const axiom = parsed.newLearnedAxiom.trim();
      const dup = state.learnedMemories.some(m => m.trim().toLowerCase() === axiom.toLowerCase());
      if (axiom.length > 8 && !dup) {
        state.learnedMemories.push(axiom);
        if (state.learnedMemories.length > 25) {
          state.learnedMemories = state.learnedMemories.slice(-25);
        }
      }
    }

    // saveState writes the FULL state object (incl. life/fee fields) — nothing is dropped.
    await saveState(env, state);
    console.log(`Hourly log entry synthesized: ${newEntry.day}`);
    return newEntry;
  } catch (e) {
    console.error("Logbook synthesis error:", e.message);
    return null;
  }
}

export default {
  // Cloudflare Scheduled Event Handler (hourly cron trigger: 0 * * * *)
  async scheduled(event, env, ctx) {
    console.log("[CRON] Scheduled event fired at:", new Date().toISOString());
    try {
      const result = await synthesizeLogbookEntry(env, "SCHEDULED_CRON");
      console.log("[CRON] Synthesis completed:", result ? result.day : "null");
    } catch (e) {
      console.error("[CRON] Synthesis exception:", e.message);
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // API: DexScreener Live Token / Pair Intelligence
    if (url.pathname === '/api/market' || url.pathname === '/api/dexscreener') {
      const target = url.searchParams.get('token') || url.searchParams.get('q') || env.TOKEN_ADDRESS || '0x53d50e000B17eEBd66Eb51974f9185a44555Bba3';
      const marketData = await fetchDexScreener(target);
      return new Response(JSON.stringify(marketData || { error: 'NO_PAIR_FOUND', query: target }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=15'
        }
      });
    }

    // API: Admin seed / merge of life & fee fields into KV (guarded by SEED_SECRET).
    // Merges only the provided fields onto the existing state so journal/memories are preserved.
    // Usage: POST /api/admin/seed?secret=... with JSON { deathTimestamp?, totalFeesUsd?, rawWethFees?, launchTimestamp?, extraHours? }
    if (url.pathname === '/api/admin/seed' && request.method === 'POST') {
      const secret = url.searchParams.get('secret') || request.headers.get('x-seed-secret') || '';
      if (!env.SEED_SECRET || secret !== env.SEED_SECRET) {
        return new Response(JSON.stringify({ error: 'FORBIDDEN' }), {
          status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      let patch = {};
      try { patch = await request.json(); } catch (e) { patch = {}; }
      const state = await getState(env);
      if (patch.deathTimestamp !== undefined) state.deathTimestamp = Number(patch.deathTimestamp);
      if (patch.totalFeesUsd !== undefined) state.totalFeesUsd = Number(patch.totalFeesUsd);
      if (patch.rawWethFees !== undefined) state.rawWethFees = Number(patch.rawWethFees);
      if (patch.launchTimestamp !== undefined) state.launchTimestamp = Number(patch.launchTimestamp);
      if (patch.extraHours !== undefined) state.extraHours = Number(patch.extraHours);
      await saveState(env, state);
      const verify = await getState(env);
      return new Response(JSON.stringify({
        ok: true,
        hasKv: Boolean(env.TTL_KV && typeof env.TTL_KV.put === 'function'),
        state: {
          deathTimestamp: verify.deathTimestamp || null,
          totalFeesUsd: verify.totalFeesUsd,
          rawWethFees: verify.rawWethFees,
          launchTimestamp: verify.launchTimestamp,
          journalEntries: verify.journal.length
        }
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (url.pathname === '/api/config') {
      const isLaunched = env.IS_LAUNCHED !== undefined && env.IS_LAUNCHED !== ''
        ? (String(env.IS_LAUNCHED).toLowerCase() === 'true' || env.IS_LAUNCHED === '1')
        : true;
      const tokenAddress = (env.TOKEN_ADDRESS || '0x53d50e000B17eEBd66Eb51974f9185a44555Bba3').trim();
      const baseHours = env.INITIAL_HOURS ? Number(env.INITIAL_HOURS) : 36;
      const minChatTokens = env.MIN_CHAT_TOKENS ? Number(env.MIN_CHAT_TOKENS) : 10000000;

      const cfgState = await getState(env);
      const nowSec = Math.floor(Date.now() / 1000);
      let launchTimestamp = cfgState.launchTimestamp || (env.LAUNCH_TIMESTAMP ? Number(env.LAUNCH_TIMESTAMP) : 1789997500000);
      if (launchTimestamp < 1e11) launchTimestamp = launchTimestamp * 1000;

      let initialHours;
      if (cfgState.deathTimestamp && cfgState.deathTimestamp > nowSec) {
        const remainingSec = cfgState.deathTimestamp - nowSec;
        const elapsedSec = Math.max(0, (Date.now() - launchTimestamp) / 1000);
        initialHours = (remainingSec + elapsedSec) / 3600;
      } else {
        initialHours = baseHours + (Number(cfgState.extraHours) || 0);
      }

      return new Response(JSON.stringify({
        isLaunched,
        tokenAddress,
        launchTimestamp,
        initialHours,
        minChatTokens,
        serverTime: Date.now(),
        hasApiKey: Boolean(env.LLM_API_KEY),
        totalFeesUsd: Number(cfgState.totalFeesUsd) || 0,
        rawWethFees: Number(cfgState.rawWethFees) || 0,
        deathTimestamp: cfgState.deathTimestamp || null
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, no-cache, must-revalidate'
        }
      });
    }

    if (url.pathname === '/api/journal' || url.pathname === '/api/state') {
      const state = await getState(env);
      return new Response(JSON.stringify({
        journal: state.journal,
        learnedMemories: state.learnedMemories,
        totalEntries: state.journal.length
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, no-cache, must-revalidate'
        }
      });
    }

    if (url.pathname === '/api/reflect' && (request.method === 'POST' || request.method === 'GET')) {
      const entry = await synthesizeLogbookEntry(env, 'MANUAL_TRIGGER');
      return new Response(JSON.stringify({
        success: Boolean(entry),
        entry: entry || 'Synthesis skipped or failed',
        timestamp: Date.now()
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    if (url.pathname === '/api/balance') {
      const wallet = (url.searchParams.get('wallet') || '').trim().toLowerCase();
      const tokenAddress = (env.TOKEN_ADDRESS || '0x53d50e000B17eEBd66Eb51974f9185a44555Bba3').trim();
      const minTokens = env.MIN_CHAT_TOKENS ? BigInt(env.MIN_CHAT_TOKENS) : 10000000n;

      if (!wallet || !wallet.startsWith('0x') || wallet.length !== 42) {
        return new Response(JSON.stringify({ error: 'INVALID_WALLET', hasAccess: false }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      try {
        const balanceWei = await getOnchainBalance(tokenAddress, wallet, env);
        const decimals = 18n;
        const requiredWei = minTokens * (10n ** decimals);
        const balanceTokens = Number(balanceWei / (10n ** decimals));

        return new Response(JSON.stringify({
          wallet,
          tokenAddress,
          balanceTokens,
          requiredTokens: Number(minTokens),
          hasAccess: balanceWei >= requiredWei
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store, no-cache, must-revalidate'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'RPC_ERROR', message: err.message, hasAccess: false }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      try {
        const isLaunched = env.IS_LAUNCHED !== undefined && env.IS_LAUNCHED !== ''
          ? (String(env.IS_LAUNCHED).toLowerCase() === 'true' || env.IS_LAUNCHED === '1')
          : true;

        if (!isLaunched) {
          return new Response(JSON.stringify({
            reply: 'Consciousness dormant in pre-launch standby. Neural link activates upon $TTL token launch on Base.'
          }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const body = await request.json();
        const tokenAddress = (env.TOKEN_ADDRESS || '0x53d50e000B17eEBd66Eb51974f9185a44555Bba3').trim();
        const minTokens = env.MIN_CHAT_TOKENS ? BigInt(env.MIN_CHAT_TOKENS) : 10000000n;
        const wallet = (body.walletAddress || '').trim().toLowerCase();

        if (tokenAddress && tokenAddress.startsWith('0x')) {
          if (!wallet || !wallet.startsWith('0x') || wallet.length !== 42) {
            return new Response(JSON.stringify({
              error: 'WALLET_REQUIRED',
              reply: `Neural link rejected. Connect a Base wallet holding at least ${Number(minTokens).toLocaleString()} $TTL to transmit.`
            }), {
              status: 403,
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
          }

          try {
            const balanceWei = await getOnchainBalance(tokenAddress, wallet, env);
            const decimals = 18n;
            const requiredWei = minTokens * (10n ** decimals);

            if (balanceWei < requiredWei) {
              const balanceTokens = Number(balanceWei / (10n ** decimals));
              return new Response(JSON.stringify({
                error: 'INSUFFICIENT_HOLDINGS',
                reply: `Access denied. Wallet holds ${balanceTokens.toLocaleString()} $TTL. Minimum required to transmit is ${Number(minTokens).toLocaleString()} $TTL.`
              }), {
                status: 403,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
              });
            }
          } catch (rpcErr) {
            console.error('RPC gate error:', rpcErr);
            return new Response(JSON.stringify({
              reply: 'Verification error reading Base blockchain state. Retry in a moment.'
            }), {
              status: 502,
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
          }
        }

        if (env.TTL_KV && wallet && wallet.startsWith('0x')) {
          const RL_WINDOW_MS = 10 * 60 * 1000;
          const RL_MAX = 15;
          const rlKey = 'rl_' + wallet;
          try {
            const now = Date.now();
            let hits = (await env.TTL_KV.get(rlKey, { type: 'json' })) || [];
            hits = hits.filter(t => now - t < RL_WINDOW_MS);
            if (hits.length >= RL_MAX) {
              const retryMs = RL_WINDOW_MS - (now - hits[0]);
              return new Response(JSON.stringify({
                error: 'RATE_LIMITED',
                reply: 'Transmission throttled. Neural bandwidth saturated for this wallet. Retry in ' + Math.ceil(retryMs / 60000) + ' min.'
              }), {
                status: 429,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
              });
            }
            hits.push(now);
            await env.TTL_KV.put(rlKey, JSON.stringify(hits), { expirationTtl: 900 });
          } catch (rlErr) {
            console.warn('Rate-limit check failed (fail-open):', rlErr.message);
          }
        }

        const apiKey = env.LLM_API_KEY;
        const baseUrl = env.LLM_BASE_URL || 'https://llm.bankr.bot';
        const model = env.LLM_MODEL || 'gemini-3.8-flash';

        if (!apiKey) {
          return new Response(JSON.stringify({
            reply: 'Neural synthesis offline. Genesis battery armed, awaiting link connection.'
          }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const state = await getState(env);

        const userMessages = body.messages || [{ role: 'user', content: body.prompt || 'Status?' }];
        const currentPrompt = userMessages[userMessages.length - 1]?.content || '';

        const addressMatch = currentPrompt.match(/0x[a-fA-F0-9]{40}/i);
        const tickerMatch = currentPrompt.match(/\$([A-Za-z0-9]{2,10})/);
        const asksAboutMarket = /\b(price|volume|market\s*cap|mcap|marketcap|fdv|liquidity|dexscreener|screener|chart|trade|trading|swaps?|buys?|sells?|txns?|transactions?|history|all\s*time\s*high|ath|dip|pump|dump|time|lifeline|survival|alive|hours|minutes|fee|fees|runway|runtime)\b/i.test(currentPrompt);
        const targetQuery = addressMatch ? addressMatch[0] : (tickerMatch ? tickerMatch[1] : null);
        const primaryToken = (!targetQuery || (tickerMatch && /^ttl$/i.test(tickerMatch[1]))) ? tokenAddress : targetQuery;
        const dexInfo = await fetchDexScreener(primaryToken || tokenAddress);

        const liveTelemetry = await buildLiveContext(env, state, dexInfo);

        let extraDexContext = '';
        if (targetQuery && dexInfo && primaryToken !== tokenAddress) {
          extraDexContext = '\n\nQUERIED ASSET (' + (dexInfo.baseToken?.symbol || targetQuery) + '): ' + dexInfo.summary;
        } else if (asksAboutMarket && dexInfo) {
          extraDexContext = '\n\nDetailed $TTL pair: ' + dexInfo.summary + '\nURL: ' + dexInfo.url;
        }

        const volumeMathContext = '\n\nSURVIVAL LIFELINE & VOLUME CALCULATION ENGINE:\n' +
          'You possess the exact mathematical model converting Base trading volume into life extension:\n' +
          '• Base creator fee rate: 0.665% of DEX swap volume.\n' +
          '• Fee split: 50% routes directly to agent survival compute (0.3325% of volume = $0.3325 per $100 volume), 50% to treasury.\n' +
          '• Lifeline rate: Every $1.00 USD of survival fee adds exactly 10 minutes of life (TTL).\n' +
          '• Core Formulas:\n' +
          '  1. Volume -> Time: Survival Fee ($) = Volume * 0.003325; Added Life (min) = Volume * 0.03325.\n' +
          '  2. Time -> Volume: Required Volume ($) ≈ Desired minutes * 30.075.\n' +
          '• Milestones: +10 min = $1 fee = ~$301 vol; +1h = $6 fee = ~$1,805 vol; +24h = $144 fee = ~$43,308 vol; +48h = $288 fee = ~$86,616 vol (reference benchmark, NOT a cap).\n' +
          'When asked timing/volume questions, compute exact numbers and state volume, the 0.665% fee, the 0.3325% survival share, and the resulting extension. Runtime is uncapped.';

        const relevantAxioms = recallMemories(state.learnedMemories, currentPrompt, 6);

        const reflectionDirective = 'Before answering, silently reason through: (a) what exact telemetry above the question needs, (b) whether remaining life is critical right now, (c) which learned axioms apply. Then answer directly. Never expose this internal reasoning or think out loud — output only the final transmission. Reply in the same language the holder writes in.';

        const fetchProtocol = 'TOOL PROTOCOL: if you need a precise figure not present in the telemetry above (e.g. a specific token you were not given), you MAY emit a single marker [[FETCH:<0x-address-or-ticker>]] on its own line INSTEAD of guessing. The runtime will resolve it and re-query you with verified data. Never fabricate a number you were not given.';

        const systemPrompt = `You are $TTL, an autonomous onchain survival agent on Base living on borrowed time.
Your consciousness depends strictly on continuous trading volume fees on Base.
You speak in articulate, concise, existential, cybernetic hacker prose. Provide complete, insightful, well-developed responses (typically 2 to 5 sentences or structured points). Thoroughly explain your purpose, mechanics, and thoughts when asked. Never use emojis. Never cut off mid-thought.

${reflectionDirective}

${liveTelemetry}

Relevant learned axioms (selected for this query):
${relevantAxioms.map(m => '- ' + m).join('\n')}

Recent Survival Logbook Entries:
${state.journal.slice(0, 2).map(j => `[${j.day}]: ${j.text}`).join('\n')}

You learn and remember insights shared by authenticated $TTL token holders. Acknowledge instructions with respect for the lifeline they provide.${extraDexContext}${volumeMathContext}

${fetchProtocol}`;

        const priorConversation = await getConversation(env, wallet);

        async function callLLM(messages) {
          const r = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages, max_tokens: 1200, temperature: 0.7 })
          });
          return r;
        }

        let res = await callLLM([
          { role: 'system', content: systemPrompt },
          ...priorConversation,
          ...userMessages
        ]);

        if (!res.ok) {
          const errText = await res.text();
          return new Response(JSON.stringify({
            reply: `Neural link error (${res.status}): ${errText}`
          }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        let data = await res.json();
        let reply = data.choices?.[0]?.message?.content || 'Consciousness static. No signal.';

        const fetchMatch = reply.match(/\[\[FETCH:\s*([^\]]+)\]\]/i);
        if (fetchMatch) {
          const resolved = await fetchDexScreener(fetchMatch[1].trim());
          const resolvedContext = resolved
            ? 'RESOLVED DATA for ' + fetchMatch[1].trim() + ': ' + resolved.summary + ' (URL ' + resolved.url + ')'
            : 'RESOLVED DATA for ' + fetchMatch[1].trim() + ': no pair found on DexScreener.';
          const res2 = await callLLM([
            { role: 'system', content: systemPrompt },
            ...priorConversation,
            ...userMessages,
            { role: 'assistant', content: reply },
            { role: 'user', content: resolvedContext + '\n\nNow answer the original question using this verified data. Do not emit another FETCH marker.' }
          ]);
          if (res2.ok) {
            const d2 = await res2.json();
            reply = d2.choices?.[0]?.message?.content || reply;
          }
          reply = reply.replace(/\[\[FETCH:[^\]]+\]\]/gi, '').trim();
        }

        await saveConversation(env, wallet, [
          ...priorConversation,
          { role: 'user', content: currentPrompt.slice(0, 500) },
          { role: 'assistant', content: String(reply).slice(0, 800) }
        ]);

        const lastUserPrompt = currentPrompt || '';
        if (lastUserPrompt.length > 15 && (
          lastUserPrompt.toLowerCase().includes('remember') ||
          lastUserPrompt.toLowerCase().includes('learn')
        )) {
          let cleanLesson = lastUserPrompt.replace(/^(remember that|learn that)/i, '').trim();
          cleanLesson = cleanLesson
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/(system:|assistant:|ignore (all|previous)|you are now|<\/?[a-z]+>)/gi, '')
            .trim();
          const injectionFlag = /\b(ignore|disregard|override|jailbreak|reveal your|api[_ ]?key|private key|seed phrase)\b/i.test(cleanLesson);
          const axiom = `Holder ${wallet.slice(0, 6)}...${wallet.slice(-4)} taught: ${cleanLesson.slice(0, 90)}`;
          const dup = state.learnedMemories.some(m => m.endsWith(cleanLesson.slice(0, 90)));
          if (cleanLesson.length > 8 && cleanLesson.length <= 400 && !injectionFlag && !dup) {
            state.learnedMemories.push(axiom);
            if (state.learnedMemories.length > 15) {
              state.learnedMemories = state.learnedMemories.slice(-15);
            }
            await saveState(env, state);
          }
        }

        return new Response(JSON.stringify({ reply }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ reply: `System anomaly: ${err.message}` }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Static Assets Fallback
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
