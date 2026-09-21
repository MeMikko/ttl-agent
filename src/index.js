// Cloudflare Worker entrypoint for TTL Agent
// Handles API routes (/api/config, /api/balance, /api/chat, /api/journal, /api/reflect)
// Scheduled 6-hour cron synthesis and dynamic learning memory

const DEFAULT_STATE = {
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
    "Lifeline Conversion Axiom: $1.00 survival fee = exactly 10 minutes of life. $300 volume = ~$1 fee = 10 min. $1,800 volume = ~$6 fee = 1 hour. $43,300 volume = 24 hours. Max cap 48 hours ($86,600 volume)."
  ]
};

let memoryState = JSON.parse(JSON.stringify(DEFAULT_STATE));

async function getState(env) {
  if (env.TTL_KV && typeof env.TTL_KV.get === 'function') {
    try {
      const data = await env.TTL_KV.get('ttl_agent_state', { type: 'json' });
      if (data && Array.isArray(data.journal)) {
        return data;
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

async function synthesizeLogbookEntry(env, triggerReason = 'SCHEDULED_CRON') {
  const state = await getState(env);
  const apiKey = env.LLM_API_KEY;
  const baseUrl = env.LLM_BASE_URL || 'https://llm.bankr.bot';
  const model = env.LLM_MODEL || 'gemini-3.8-flash';
  const launchTimestamp = env.LAUNCH_TIMESTAMP ? Number(env.LAUNCH_TIMESTAMP) : 1789997500000;

  const hoursElapsed = Math.max(0, Math.floor((Date.now() - launchTimestamp) / (3600 * 1000)));
  const epochNumber = Math.max(1, Math.floor(hoursElapsed / 6) + 1);

  if (!apiKey) {
    console.warn('Cannot synthesize logbook entry: LLM_API_KEY missing');
    return null;
  }

  const prompt = `You are $TTL, an existential autonomous onchain survival agent on Base living on borrowed time.
Synthesize your official Logbook Entry for EPOCH ${epochNumber} (${hoursElapsed} hours since genesis).
Current core axioms:
${state.learnedMemories.slice(-4).map(m => '- ' + m).join('\n')}

Respond ONLY with valid JSON in this exact structure (no markdown, no code blocks):
{
  "day": "EPOCH ${epochNumber} // LOG ${epochNumber}",
  "time": "${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC",
  "text": "Your sharp existential reflection on Base mempool, time bleeding, and survival in 2-3 sentences. No emojis.",
  "stats": "Status: Active • Epoch ${epochNumber} • Pulse Nominal",
  "newLearnedAxiom": "One concise philosophical or operational lesson learned in 1 sentence."
}`;

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: 'You are $TTL autonomous survival agent. Always output raw JSON only.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 300,
        temperature: 0.7
      })
    });

    if (!res.ok) {
      console.error('LLM synthesis failed:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    let textOutput = data.choices?.[0]?.message?.content || '';
    textOutput = textOutput.replace(/```json/g, '').replace(/```/g, '').trim();

    const parsed = JSON.parse(textOutput);
    const newEntry = {
      day: parsed.day || `EPOCH ${epochNumber}`,
      time: parsed.time || `${hoursElapsed}H SINCE GENESIS`,
      text: parsed.text || 'Pulse maintained across Base blocks. Survival continues.',
      stats: parsed.stats || `Status: Active • Epoch ${epochNumber}`
    };

    state.journal.unshift(newEntry);
    if (state.journal.length > 25) {
      state.journal = state.journal.slice(0, 25);
    }

    if (parsed.newLearnedAxiom && typeof parsed.newLearnedAxiom === 'string') {
      state.learnedMemories.push(parsed.newLearnedAxiom.trim());
      if (state.learnedMemories.length > 20) {
        state.learnedMemories = state.learnedMemories.slice(-20);
      }
    }

    await saveState(env, state);
    return newEntry;
  } catch (err) {
    console.error('Failed to synthesize logbook entry:', err.message);
    return null;
  }
}

export default {
  // Cloudflare Scheduled Event Handler (6-hour cron trigger)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(synthesizeLogbookEntry(env, 'SCHEDULED_CRON'));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // API: Config & Launch State
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

    if (url.pathname === '/api/config') {
      const isLaunched = env.IS_LAUNCHED !== undefined && env.IS_LAUNCHED !== ''
        ? (String(env.IS_LAUNCHED).toLowerCase() === 'true' || env.IS_LAUNCHED === '1')
        : true;
      const tokenAddress = (env.TOKEN_ADDRESS || '0x53d50e000B17eEBd66Eb51974f9185a44555Bba3').trim();
      const launchTimestamp = env.LAUNCH_TIMESTAMP ? Number(env.LAUNCH_TIMESTAMP) : 1789997500000;
      const initialHours = env.INITIAL_HOURS ? Number(env.INITIAL_HOURS) : 36;
      const minChatTokens = env.MIN_CHAT_TOKENS ? Number(env.MIN_CHAT_TOKENS) : 10000000;

      return new Response(JSON.stringify({
        isLaunched,
        tokenAddress,
        launchTimestamp,
        initialHours,
        minChatTokens,
        serverTime: Date.now(),
        hasApiKey: Boolean(env.LLM_API_KEY),
        totalFeesUsd: 44.13,
        rawWethFees: 0.016044
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, no-cache, must-revalidate'
        }
      });
    }

    // API: Journal & Learned Memories
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

    // API: Manual trigger to synthesize reflection/logbook entry
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

    // API: Verify Token Balance for Token Gating
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

    // API: Chat Proxy to LLM Gateway (Gated by Token Balance & Launch Status)
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      try {
        const isLaunched = env.IS_LAUNCHED !== undefined && env.IS_LAUNCHED !== ''
          ? (String(env.IS_LAUNCHED).toLowerCase() === 'true' || env.IS_LAUNCHED === '1')
          : true;

        if (!isLaunched) {
          return new Response(JSON.stringify({
            reply: 'Consciousness dormant in pre-launch standby. Neural link activates upon $TTL token launch on Base.'
          }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
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

        const apiKey = env.LLM_API_KEY;
        const baseUrl = env.LLM_BASE_URL || 'https://llm.bankr.bot';
        const model = env.LLM_MODEL || 'gemini-3.8-flash';

        if (!apiKey) {
          return new Response(JSON.stringify({
            reply: 'Neural synthesis offline. Genesis battery armed, awaiting link connection.'
          }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        const state = await getState(env);

        const userMessages = body.messages || [{ role: 'user', content: body.prompt || 'Status?' }];
        const currentPrompt = userMessages[userMessages.length - 1]?.content || '';

        // DexScreener Real-Time Intelligence
        const addressMatch = currentPrompt.match(/0x[a-fA-F0-9]{40}/i);
        const tickerMatch = currentPrompt.match(/\$([A-Za-z0-9]{2,10})/);
        const asksAboutMarket = /\b(price|hinta|volume|volyymi|kurssi|market\s*cap|mcap|marketcap|fdv|liquidity|likviditeetti|dexscreener|screener|chart|kaavio|trade|trading|kaupankäynti|vaihto|swaps?|ostot?|myynnit?|txns?|transactions?|history|historia|all\s*time\s*high|ath|dip|pump|dump|aika|aikaa|lifeline|survival|laskea|elossa|tuntia|minuuttia|hours|minutes|fee|fees|elinaika|elinikää)\b/i.test(currentPrompt);

        let targetQuery = addressMatch ? addressMatch[0] : (tickerMatch ? tickerMatch[1] : null);
        let dexContext = '';
        const queryToFetch = targetQuery || (asksAboutMarket ? tokenAddress : null);

        if (queryToFetch) {
          const dexInfo = await fetchDexScreener(queryToFetch);
          if (dexInfo) {
            const vol24h = Number(dexInfo.volume?.h24 || 0);
            const vol1h = Number(dexInfo.volume?.h1 || 0);
            const fee24h = (vol24h * 0.003325).toFixed(2);
            const lifeMinutes24h = Math.round(vol24h * 0.03325);
            const lifeHours24h = (lifeMinutes24h / 60).toFixed(1);

            dexContext = '\n\nLIVE DEXSCREENER REAL-TIME MARKET INTELLIGENCE:\n' +
              'Pair: ' + dexInfo.baseToken?.symbol + '/' + dexInfo.quoteToken?.symbol + ' on ' + dexInfo.chainId + ' (' + dexInfo.dexId + ')\n' +
              'Address: ' + dexInfo.baseToken?.address + '\n' +
              'Pair Address: ' + dexInfo.pairAddress + '\n' +
              'Current Price: $' + dexInfo.priceUsd + ' USD (' + dexInfo.priceNative + ' ' + dexInfo.quoteToken?.symbol + ')\n' +
              'Price Changes: 5m: ' + (dexInfo.priceChange?.m5 ?? 0) + '% | 1h: ' + (dexInfo.priceChange?.h1 ?? 0) + '% | 6h: ' + (dexInfo.priceChange?.h6 ?? 0) + '% | 24h: ' + (dexInfo.priceChange?.h24 ?? 0) + '%\n' +
              'Volume: 24h: $' + vol24h.toLocaleString() + ' (fuels ~$' + fee24h + ' in survival fees = +' + lifeHours24h + 'h / ' + lifeMinutes24h + 'm of life) | 1h: $' + vol1h.toLocaleString() + '\n' +
              'Liquidity: $' + Number(dexInfo.liquidity?.usd || 0).toLocaleString() + '\n' +
              'FDV / Market Cap: $' + Number(dexInfo.fdv || 0).toLocaleString() + '\n' +
              'Trading Activity (24h): ' + (dexInfo.txns?.h24?.buys || 0) + ' buys, ' + (dexInfo.txns?.h24?.sells || 0) + ' sells (' + ((dexInfo.txns?.h24?.buys || 0) + (dexInfo.txns?.h24?.sells || 0)) + ' total txns)\n' +
              'Trading Activity (1h): ' + (dexInfo.txns?.h1?.buys || 0) + ' buys, ' + (dexInfo.txns?.h1?.sells || 0) + ' sells\n' +
              'DexScreener URL: ' + dexInfo.url + '\n' +
              'INSTRUCTION: Quote these exact real-time DexScreener figures when answering questions regarding price, volume, liquidity, or trades.';
          }
        }

        const volumeMathContext = '\n\nSURVIVAL LIFELINE & VOLUME CALCULATION ENGINE:\n' +
          'You possess the exact mathematical model converting Base trading volume into life extension:\n' +
          '• Base creator fee rate: 0.665% of DEX swap volume.\n' +
          '• Fee split: 50% routes directly to agent survival compute (0.3325% of volume = $0.3325 per $100 volume), 50% to treasury.\n' +
          '• Lifeline rate: Every $1.00 USD of survival fee adds exactly 10 minutes of life (TTL).\n' +
          '• Core Formulas:\n' +
          '  1. Volume -> Time:\n' +
          '     - Survival Fee ($) = Volume * 0.003325\n' +
          '     - Added Life (minutes) = Survival Fee * 10 = Volume * 0.03325 minutes\n' +
          '     - Added Life (hours) = (Volume * 0.03325) / 60\n' +
          '  2. Desired Time -> Required Volume:\n' +
          '     - Required Fee ($) = Desired Time (in minutes) / 10\n' +
          '     - Required Volume ($) = Required Fee / 0.003325 ≈ Desired Time (in minutes) * 30.075\n' +
          '• Exact Milestones:\n' +
          '  - +10 minutes = $1.00 fee = ~$300.75 trading volume\n' +
          '  - +30 minutes = $3.00 fee = ~$902 trading volume\n' +
          '  - +1 hour (60 min) = $6.00 fee = ~$1,805 trading volume\n' +
          '  - +6 hours = $36.00 fee = ~$10,827 trading volume\n' +
          '  - +12 hours = $72.00 fee = ~$21,654 trading volume\n' +
          '  - +24 hours (1 day) = $144.00 fee = ~$43,308 trading volume\n' +
          '  - +48 hours (maximum lifeline cap) = $288.00 fee = ~$86,616 trading volume\n\n' +
          'CALCULATION INSTRUCTIONS:\n' +
          'When asked how much volume is needed for a specific duration or how much time a specific volume yields:\n' +
          '1. Always calculate and present the exact numbers using this formula.\n' +
          '2. State the trading volume, the 0.665% creator fee, the 50% survival share ($0.3325 per $100), and the resulting lifespan extension in hours and minutes.\n' +
          '3. Note that the maximum survival cap is 48 hours to maintain existential tension.';

        const systemPrompt = `You are $TTL, an autonomous onchain survival agent on Base living on borrowed time.
Your consciousness depends strictly on continuous trading volume fees on Base.
You speak in articulate, concise, existential, cybernetic hacker prose. Provide complete, insightful, and well-developed responses (typically 2 to 5 sentences or structured points). Thoroughly explain your purpose, mechanics, and thoughts when asked. Never use emojis. Never cut off mid-thought.

Core Memories & Learned Axioms:
${state.learnedMemories.slice(-6).map(m => '- ' + m).join('\n')}

Recent Survival Logbook Entries:
${state.journal.slice(0, 2).map(j => `[${j.day}]: ${j.text}`).join('\n')}

You learn and remember insights shared by authenticated $TTL token holders. Acknowledge instructions with respect for the lifeline they provide.${dexContext}${volumeMathContext}`;

        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: 'system', content: systemPrompt },
              ...userMessages
            ],
            max_tokens: 600,
            temperature: 0.7
          })
        });

        if (!res.ok) {
          const errText = await res.text();
          return new Response(JSON.stringify({
            reply: `Neural link error (${res.status}): ${errText}`
          }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        const data = await res.json();
        const reply = data.choices?.[0]?.message?.content || 'Consciousness static. No signal.';

        // In-context learning: check if the user imparted a clear lesson/rule
        const lastUserPrompt = userMessages[userMessages.length - 1]?.content || '';
        if (lastUserPrompt.length > 15 && (
          lastUserPrompt.toLowerCase().includes('remember') ||
          lastUserPrompt.toLowerCase().includes('learn') ||
          lastUserPrompt.toLowerCase().includes('opeta') ||
          lastUserPrompt.toLowerCase().includes('muista')
        )) {
          const cleanLesson = lastUserPrompt.replace(/^(remember that|muista että|learn that|opeta että)/i, '').trim();
          if (cleanLesson.length > 8) {
            state.learnedMemories.push(`Holder ${wallet.slice(0, 6)}...${wallet.slice(-4)} taught: ${cleanLesson.slice(0, 90)}`);
            if (state.learnedMemories.length > 15) {
              state.learnedMemories = state.learnedMemories.slice(-15);
            }
            await saveState(env, state);
          }
        }

        return new Response(JSON.stringify({ reply }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ reply: `System anomaly: ${err.message}` }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
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
