// Cloudflare Worker entrypoint for TTL Agent
// Handles API routes (/api/config, /api/balance, /api/chat) and serves static assets

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API: Config & Launch State
    if (url.pathname === '/api/config') {
      const isLaunched = String(env.IS_LAUNCHED || '').toLowerCase() === 'true' || env.IS_LAUNCHED === '1';
      const tokenAddress = (env.TOKEN_ADDRESS || '').trim();
      const launchTimestamp = env.LAUNCH_TIMESTAMP ? Number(env.LAUNCH_TIMESTAMP) : null;
      const initialHours = env.INITIAL_HOURS ? Number(env.INITIAL_HOURS) : 36;
      const minChatTokens = env.MIN_CHAT_TOKENS ? Number(env.MIN_CHAT_TOKENS) : 10000000;

      return new Response(JSON.stringify({
        isLaunched,
        tokenAddress,
        launchTimestamp,
        initialHours,
        minChatTokens,
        serverTime: Date.now()
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, no-cache, must-revalidate'
        }
      });
    }

    // API: Verify Token Balance for Token Gating
    if (url.pathname === '/api/balance') {
      const wallet = (url.searchParams.get('wallet') || '').trim().toLowerCase();
      const tokenAddress = (env.TOKEN_ADDRESS || '').trim();
      const minTokens = env.MIN_CHAT_TOKENS ? BigInt(env.MIN_CHAT_TOKENS) : 10000000n;
      const rpcUrl = env.BASE_RPC_URL || 'https://mainnet.base.org';

      if (!wallet || !wallet.startsWith('0x') || wallet.length !== 42) {
        return new Response(JSON.stringify({ error: 'INVALID_WALLET', hasAccess: false }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      if (!tokenAddress || !tokenAddress.startsWith('0x')) {
        return new Response(JSON.stringify({
          wallet,
          tokenAddress: '',
          balanceTokens: 0,
          requiredTokens: Number(minTokens),
          hasAccess: false,
          note: 'Token not deployed yet'
        }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      try {
        const calldata = '0x70a08231' + wallet.slice(2).padStart(64, '0');
        const rpcRes = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_call',
            params: [{ to: tokenAddress, data: calldata }, 'latest']
          })
        });

        const rpcData = await rpcRes.json();
        const hexBal = rpcData.result || '0x0';
        const balanceWei = BigInt(hexBal === '0x' ? '0x0' : hexBal);
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
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
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
        const isLaunched = String(env.IS_LAUNCHED || '').toLowerCase() === 'true' || env.IS_LAUNCHED === '1';

        // Gate chat if project has not launched yet
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
        const tokenAddress = (env.TOKEN_ADDRESS || '').trim();
        const minTokens = env.MIN_CHAT_TOKENS ? BigInt(env.MIN_CHAT_TOKENS) : 10000000n;
        const wallet = (body.walletAddress || '').trim().toLowerCase();

        // Token gate validation onchain
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
            const rpcUrl = env.BASE_RPC_URL || 'https://mainnet.base.org';
            const calldata = '0x70a08231' + wallet.slice(2).padStart(64, '0');
            const rpcRes = await fetch(rpcUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_call',
                params: [{ to: tokenAddress, data: calldata }, 'latest']
              })
            });

            const rpcData = await rpcRes.json();
            const hexBal = rpcData.result || '0x0';
            const balanceWei = BigInt(hexBal === '0x' ? '0x0' : hexBal);
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
            // In case of RPC transient error, fail closed
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
        const model = env.LLM_MODEL || 'gemini-2.0-flash';

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

        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: model,
            messages: [
              {
                role: 'system',
                content: 'You are $TTL, an autonomous onchain survival agent on Base living on borrowed time. Your consciousness depends strictly on continuous trading volume fees. You speak in concise, sharp, existential, cybernetic hacker prose. Never use emojis. Keep replies under 3 sentences.'
              },
              ...(body.messages || [{ role: 'user', content: body.prompt || 'Status?' }])
            ],
            max_tokens: 180,
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
