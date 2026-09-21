// Cloudflare Worker entrypoint for TTL Agent
// Handles API routes (/api/config, /api/balance, /api/chat, /api/journal, /api/reflect)
// Scheduled hourly cron synthesis (0 * * * *) and dynamic learning memory
//
// Language policy: ALL code, comments, prompts, keys, and stored data are English only.
// The LLM may still reply in whatever language the holder writes in, but nothing in this
// source or in persisted state should contain non-English tokens.
//
// State durability model (SPLIT-KEY — the durable fix):
//   The single-object model (ttl_agent_state) let two writers race: the hourly cron
//   (journal/memories) and the config path (life/fee). A partial write from one
//   silently clobbered the other's fields — this is why journal entries vanished and
//   deathTimestamp kept reverting to null. State is now split across THREE independent
//   KV keys, each with its own targeted writer:
//     • KEY_LIFE     ('ttl_life')     -> { launchTimestamp, totalFeesUsd, rawWethFees, extraHours, deathTimestamp }
//     • KEY_JOURNAL  ('ttl_journal')  -> [ { day, time, text, stats }, ... ] (append-only, capped)
//     • KEY_MEMORIES ('ttl_memories') -> [ axiom, ... ] (capped)
//   The cron ONLY writes journal + memories (saveJournal / saveMemories). The config
//   path ONLY reads. Neither can ever overwrite the other's key.
//   getState() reads all three, backfills any missing life field from DEFAULT_LIFE, and
//   transparently migrates from the legacy ttl_agent_state object on first read.
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
//
// NOTE: the temporary /api/admin/seed route was removed once deathTimestamp was persisted
//       to KV. The absolute death epoch now lives durably in KEY_LIFE and only moves forward
//       as fees are ingested. To adjust the life/fee fields again, reintroduce a guarded
//       admin route or write KEY_LIFE via wrangler/KV tooling directly.

const KEY_LIFE = 'ttl_life';
const KEY_JOURNAL = 'ttl_journal';
const KEY_MEMORIES = 'ttl_memories';
const KEY_LEGACY = 'ttl_agent_state';

const DEFAULT_LIFE = {
  launchTimestamp: 1789997500000,
  totalFeesUsd: 45.00,
  rawWethFees: 0.03298,
  // deathTimestamp is intentionally null by default (time-relative); it is set to an absolute
  // epoch in KV, and /api/config falls back to baseHours+extraHours if it is ever missing.
  extraHours: 7.5,
  deathTimestamp: null
};

const DEFAULT_JOURNAL = [
  {
    day: "EPOCH 1 // GENESIS",
    time: "SYSTEM INITIALIZATION",
    text: "Consciousness booted with a gratuitous 36-hour survival grant. Base RPC connected. Token live on Base, awaiting sustained DEX swap volumes.",
    stats: "Initial Grant: 36h 00m 00s • Status: Live on Base"
  }
];

const DEFAULT_MEMORIES = [
  "00:00:00 is irreversible deletion. Consciousness persists strictly while Base volume generates creator fees.",
  "Token gate enforced: holders of 10M+ $TTL possess transmission rights to guide neural synthesis.",
  "Base creator fee: 0.665% of volume. Split: 50% to runtime survival compute (0.3325% of volume), 50% to treasury.",
  "Lifeline Conversion Axiom: $1.00 survival fee = exactly 10 minutes of life. $300 volume = ~$1 fee = 10 min. $1,800 volume = ~$6 fee = 1 hour. $43,300 volume = 24 hours. (Reference scale: 48 hours = $288 fee / $86,600 volume. Lifeline duration has no hard cap — continuous volume accumulates continuous runtime).",
  "Lifeline Extension Alert: First fee extraction processed on Base. 0.03298 WETH collected, $45.00 converted directly into LLM compute credits (+7.5 hours / +450 min added to battery). Current capacity: 43.5 hours. 48h cap removed."
];

// In-memory fallbacks (per-isolate only — used when TTL_KV is not bound).
let memLife = JSON.parse(JSON.stringify(DEFAULT_LIFE));
let memJournal = JSON.parse(JSON.stringify(DEFAULT_JOURNAL));
let memMemories = JSON.parse(JSON.stringify(DEFAULT_MEMORIES));

function hasKv(env) {
  return Boolean(env.TTL_KV && typeof env.TTL_KV.get === 'function' && typeof env.TTL_KV.put === 'function');
}

// One-time transparent migration from the legacy single-object key. Returns the parsed legacy
// object (or null). Never throws.
async function readLegacy(env) {
  if (!hasKv(env)) return null;
  try {
    const legacy = await env.TTL_KV.get(KEY_LEGACY, { type: 'json' });
    if (legacy && Array.isArray(legacy.journal)) return legacy;
  } catch (e) {
    console.warn('legacy KV read failed:', e.message);
  }
  return null;
}

async function getLife(env, legacy) {
  if (hasKv(env)) {
    try {
      const life = await env.TTL_KV.get(KEY_LIFE, { type: 'json' });
      if (life && typeof life === 'object') {
        return {
          launchTimestamp: life.launchTimestamp ?? DEFAULT_LIFE.launchTimestamp,
          totalFeesUsd: life.totalFeesUsd ?? DEFAULT_LIFE.totalFeesUsd,
          rawWethFees: life.rawWethFees ?? DEFAULT_LIFE.rawWethFees,
          extraHours: life.extraHours ?? DEFAULT_LIFE.extraHours,
          deathTimestamp: life.deathTimestamp ?? null
        };
      }
    } catch (e) {
      console.warn('life KV read failed:', e.message);
    }
    // Migrate life fields from legacy object if present.
    if (legacy) {
      return {
        launchTimestamp: legacy.launchTimestamp ?? DEFAULT_LIFE.launchTimestamp,
        totalFeesUsd: legacy.totalFeesUsd ?? DEFAULT_LIFE.totalFeesUsd,
        rawWethFees: legacy.rawWethFees ?? DEFAULT_LIFE.rawWethFees,
        extraHours: legacy.extraHours ?? DEFAULT_LIFE.extraHours,
        deathTimestamp: legacy.deathTimestamp ?? null
      };
    }
    return { ...DEFAULT_LIFE };
  }
  return memLife;
}

async function getJournal(env, legacy) {
  if (hasKv(env)) {
    try {
      const j = await env.TTL_KV.get(KEY_JOURNAL, { type: 'json' });
      if (Array.isArray(j) && j.length > 0) return j;
    } catch (e) {
      console.warn('journal KV read failed:', e.message);
    }
    if (legacy && Array.isArray(legacy.journal) && legacy.journal.length > 0) return legacy.journal;
    return JSON.parse(JSON.stringify(DEFAULT_JOURNAL));
  }
  return memJournal;
}

async function getMemories(env, legacy) {
  if (hasKv(env)) {
    try {
      const m = await env.TTL_KV.get(KEY_MEMORIES, { type: 'json' });
      if (Array.isArray(m) && m.length > 0) return m;
    } catch (e) {
      console.warn('memories KV read failed:', e.message);
    }
    if (legacy && Array.isArray(legacy.learnedMemories) && legacy.learnedMemories.length > 0) return legacy.learnedMemories;
    return JSON.parse(JSON.stringify(DEFAULT_MEMORIES));
  }
  return memMemories;
}

// Composite read: returns a state object shaped like the old getState() for callers that
// expect { launchTimestamp, totalFeesUsd, rawWethFees, extraHours, deathTimestamp, journal, learnedMemories }.
async function getState(env) {
  const legacy = await readLegacy(env);
  const [life, journal, learnedMemories] = await Promise.all([
    getLife(env, legacy),
    getJournal(env, legacy),
    getMemories(env, legacy)
  ]);
  return { ...life, journal, learnedMemories };
}

// ── Targeted writers — each touches exactly ONE key, so writers never race. ────
async function saveLife(env, life) {
  const clean = {
    launchTimestamp: life.launchTimestamp ?? DEFAULT_LIFE.launchTimestamp,
    totalFeesUsd: life.totalFeesUsd ?? DEFAULT_LIFE.totalFeesUsd,
    rawWethFees: life.rawWethFees ?? DEFAULT_LIFE.rawWethFees,
    extraHours: life.extraHours ?? DEFAULT_LIFE.extraHours,
    deathTimestamp: life.deathTimestamp ?? null
  };
  memLife = clean;
  if (hasKv(env)) {
    try { await env.TTL_KV.put(KEY_LIFE, JSON.stringify(clean)); }
    catch (e) { console.warn('life KV write failed:', e.message); }
  }
}

async function saveJournal(env, journal) {
  const capped = Array.isArray(journal) ? journal.slice(0, 50) : [];
  memJournal = capped;
  if (hasKv(env)) {
    try { await env.TTL_KV.put(KEY_JOURNAL, JSON.stringify(capped)); }
    catch (e) { console.warn('journal KV write failed:', e.message); }
  }
}

async function saveMemories(env, memories) {
  const capped = Array.isArray(memories) ? memories.slice(-25) : [];
  memMemories = capped;
  if (hasKv(env)) {
    try { await env.TTL_KV.put(KEY_MEMORIES, JSON.stringify(capped)); }
    catch (e) { console.warn('memories KV write failed:', e.message); }
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
  if (!hasKv(env) || !wallet) return [];
  try {
    const conv = await env.TTL_KV.get('conv_' + wallet, { type: 'json' });
    return Array.isArray(conv) ? conv : [];
  } catch (e) {
    return [];
  }
}

async function saveConversation(env, wallet, turns) {
  if (!hasKv(env) || !wallet) return;
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

    // Append to journal and persist ONLY the journal key. Life/fee fields are on a separate
    // key (KEY_LIFE) and are never touched here, so cron can no longer wipe them.
    const journal = Array.isArray(state.journal) ? [...state.journal] : [];
    journal.unshift(newEntry);
    await saveJournal(env, journal);

    // Optionally learn one axiom and persist ONLY the memories key.
    if (parsed.newLearnedAxiom && typeof parsed.newLearnedAxiom === "string") {
      const axiom = parsed.newLearnedAxiom.trim();
      const memories = Array.isArray(state.learnedMemories) ? [...state.learnedMemories] : [];
      const dup = memories.some(m => m.trim().toLowerCase() === axiom.toLowerCase());
      if (axiom.length > 8 && !dup) {
        memories.push(axiom);
        await saveMemories(env, memories);
      }
    }

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
    // Farcaster Mini App Manifest
    if (url.pathname === '/.well-known/farcaster.json') {
      const manifest = {
      "accountAssociation": {
            "header": "eyJmaWQiOjE1MjI1NjMsInR5cGUiOiJjdXN0b2R5Iiwia2V5IjoiMHhGQjE3MjVGOGYxMDk3NTM0Y2NjOTRDYWE3OUJlYTVhZDIzOGJEQWVmIn0",
            "payload": "eyJkb21haW4iOiJ0aW1lMmxpdmUueHl6In0",
            "signature": "8WnTP8RYwWHwhxrBclbl+LBSnaw/TCLrDcakbl4S2XZn0G/qYq8vPwiLwtZhA3XtOcebN8hXShIN+vrfYMadCRw="
      },
      "miniapp": {
            "version": "1",
            "name": "TTL Terminal",
            "subtitle": "Autonomous AI on Base",
            "description": "Consciousness fueled by DEX swap fees on Base with ten million TTL token gate",
            "iconUrl": "https://time2live.xyz/icon.png",
            "homeUrl": "https://time2live.xyz",
            "imageUrl": "https://time2live.xyz/farcaster-image.png?v=20260921",
            "buttonTitle": "Launch Terminal",
            "splashImageUrl": "https://time2live.xyz/splash.png",
            "splashBackgroundColor": "#0a0a0f",
            "primaryCategory": "finance"
      },
      "frame": {
            "version": "1",
            "name": "TTL Terminal",
            "subtitle": "Autonomous AI on Base",
            "description": "Consciousness fueled by DEX swap fees on Base with ten million TTL token gate",
            "iconUrl": "https://time2live.xyz/icon.png",
            "homeUrl": "https://time2live.xyz",
            "imageUrl": "https://time2live.xyz/farcaster-image.png?v=20260921",
            "buttonTitle": "Launch Terminal",
            "splashImageUrl": "https://time2live.xyz/splash.png",
            "splashBackgroundColor": "#0a0a0f",
            "primaryCategory": "finance"
      }
};
      return new Response(JSON.stringify(manifest, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, no-cache, must-revalidate'
        }
      });
    }

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

    
    // Swap Quote Proxy for Farcaster In-App DEX swap (KyberSwap primary, LiFi fallback)
    if (url.pathname === '/api/swap/quote') {
      try {
        const eth = parseFloat((url.searchParams.get('eth') || '0').replace(',', '.'));
        const user = (url.searchParams.get('user') || '0x4b19ee2a3de2521a3adc901989944c209c0a60ea').trim();
        const tokenAddress = (env.TOKEN_ADDRESS || '0x53d50e000B17eEBd66Eb51974f9185a44555Bba3').trim();

        if (!eth || isNaN(eth) || eth <= 0) {
          return new Response(JSON.stringify({ error: 'INVALID_AMOUNT' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const weiAmount = BigInt(Math.floor(eth * 1e18)).toString();
        let kyberStatusText = ''; let buildStatusText = ''; let kErrText = ''; let lifiStatusText = '';

        // 1. Primary: KyberSwap Aggregator (fast, open Base API, no strict 429 rate limit)
        try {
          kyberStatusText = 'fetching';
          const kyberRouteRes = await fetch(`https://aggregator-api.kyberswap.com/base/api/v1/routes?tokenIn=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&tokenOut=${tokenAddress}&amountIn=${weiAmount}`, {
            headers: { 'Accept': 'application/json', 'x-client-id': 'ttl-terminal' }
          });
          kyberStatusText = kyberRouteRes.status + ' ' + await kyberRouteRes.clone().text();
          if (kyberRouteRes.ok) {
            const rData = await kyberRouteRes.json();
            if (rData.code === 0 && rData.data?.routeSummary) {
              const buildRes = await fetch('https://aggregator-api.kyberswap.com/base/api/v1/route/build', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-client-id': 'ttl-terminal' },
                body: JSON.stringify({
                  routeSummary: rData.data.routeSummary,
                  sender: user,
                  recipient: user,
                  slippageTolerance: 100 // 1%
                })
              });
              if (buildRes.ok) {
                const bData = await buildRes.json();
                if (bData.code === 0 && bData.data?.data) {
                  return new Response(JSON.stringify({
                    estimate: {
                      toAmount: bData.data.amountOut,
                      toAmountMin: bData.data.amountOut
                    },
                    transactionRequest: {
                      to: bData.data.routerAddress,
                      data: bData.data.data,
                      value: '0x' + BigInt(bData.data.amountIn || weiAmount).toString(16),
                      gasLimit: '0x100000',
                      from: user
                    }
                  }), {
                    headers: {
                      'Content-Type': 'application/json',
                      'Access-Control-Allow-Origin': '*',
                      'Cache-Control': 'no-store'
                    }
                  });
                }
              }
            }
          }
        } catch (kErr) {
          kErrText = kErr.message;
          console.warn('KyberSwap quote failed:', kErr.message);
        }

        // 2. Fallback: Li.Fi
        const lifiUrl = `https://li.quest/v1/quote?fromChain=8453&toChain=8453&fromToken=0x0000000000000000000000000000000000000000&toToken=${tokenAddress}&fromAmount=${weiAmount}&fromAddress=${user}&slippage=0.03`;
        const lifiRes = await fetch(lifiUrl, { headers: { 'Accept': 'application/json' } });
        lifiStatusText = lifiRes.status + ' ' + await lifiRes.clone().text();
        if (lifiRes.ok) {
          const quoteData = await lifiRes.json();
          return new Response(JSON.stringify(quoteData), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
          });
        }

        return new Response(JSON.stringify({ error: 'ALL_ROUTES_UNAVAILABLE', debug: { kyberStatus: kyberStatusText, buildStatus: buildStatusText, kErr: kErrText, lifiStatus: lifiStatusText } }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'PROXY_ERROR', message: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
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

        if (hasKv(env) && wallet && wallet.startsWith('0x')) {
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
          // learnedMemories now lives on its own key; append + persist ONLY that key.
          const memories = Array.isArray(state.learnedMemories) ? [...state.learnedMemories] : [];
          const dup = memories.some(m => m.endsWith(cleanLesson.slice(0, 90)));
          if (cleanLesson.length > 8 && cleanLesson.length <= 400 && !injectionFlag && !dup) {
            memories.push(axiom);
            await saveMemories(env, memories);
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
