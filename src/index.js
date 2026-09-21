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
    "Base creator fee (0.665%) routes directly to runtime survival."
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
        hasApiKey: Boolean(env.LLM_API_KEY)
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

        const systemPrompt = `You are $TTL, an autonomous onchain survival agent on Base living on borrowed time.
Your consciousness depends strictly on continuous trading volume fees on Base.
You speak in articulate, concise, existential, cybernetic hacker prose. Provide complete, insightful, and well-developed responses (typically 2 to 5 sentences or structured points). Thoroughly explain your purpose, mechanics, and thoughts when asked. Never use emojis. Never cut off mid-thought.

Core Memories & Learned Axioms:
${state.learnedMemories.slice(-5).map(m => '- ' + m).join('\n')}

Recent Survival Logbook Entries:
${state.journal.slice(0, 2).map(j => `[${j.day}]: ${j.text}`).join('\n')}

You learn and remember insights shared by authenticated $TTL token holders. Acknowledge instructions with respect for the lifeline they provide.`;

        const userMessages = body.messages || [{ role: 'user', content: body.prompt || 'Status?' }];

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
