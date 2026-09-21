// Cloudflare Pages Function: POST /api/chat with DexScreener Intelligence
async function fetchDexScreener(queryOrAddress) {
  if (!queryOrAddress) return null;
  try {
    const isAddress = /^0x[a-fA-F0-9]{40}$/i.test(queryOrAddress.trim());
    const endpoint = isAddress
      ? "https://api.dexscreener.com/latest/dex/tokens/" + queryOrAddress.trim()
      : "https://api.dexscreener.com/latest/dex/search?q=" + encodeURIComponent(queryOrAddress.trim());

    const res = await fetch(endpoint, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TTL-Agent/1.0)",
        "Accept": "application/json"
      }
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.pairs || data.pairs.length === 0) return null;

    const pairs = [...data.pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return pairs[0];
  } catch (err) {
    return null;
  }
}

export async function onRequestPost(context) {
  const env = context.env || {};
  const request = context.request;

  try {
    const isLaunched = String(env.IS_LAUNCHED || "").toLowerCase() === "true" || env.IS_LAUNCHED === "1";
    if (!isLaunched) {
      return new Response(JSON.stringify({
        reply: "Consciousness dormant in pre-launch standby. Neural link activates upon $TTL token launch on Base."
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const body = await request.json();
    const apiKey = env.LLM_API_KEY;
    const baseUrl = env.LLM_BASE_URL || "https://llm.bankr.bot";
    const model = env.LLM_MODEL || "gemini-2.0-flash";

    if (!apiKey) {
      return new Response(JSON.stringify({
        reply: "Neural synthesis offline. Genesis battery armed, awaiting link connection."
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const userMessages = body.messages || [{ role: "user", content: body.prompt || "Status?" }];
    const currentPrompt = userMessages[userMessages.length - 1]?.content || "";

    // DexScreener Intelligence
    const addressMatch = currentPrompt.match(/0x[a-fA-F0-9]{40}/i);
    const tickerMatch = currentPrompt.match(/\$([A-Za-z0-9]{2,10})/);
    const asksAboutMarket = /\b(price|hinta|volume|volyymi|kurssi|market\s*cap|mcap|marketcap|fdv|liquidity|likviditeetti|dexscreener|screener|chart|kaavio|trade|trading|kaupankäynti|vaihto|swaps?|ostot?|myynnit?|txns?|transactions?|history|historia)\b/i.test(currentPrompt);

    const tokenAddress = (env.TOKEN_ADDRESS || "0x53d50e000B17eEBd66Eb51974f9185a44555Bba3").trim();
    const queryToFetch = addressMatch ? addressMatch[0] : (tickerMatch ? tickerMatch[1] : (asksAboutMarket ? tokenAddress : null));

    let dexContext = "";
    if (queryToFetch) {
      const pair = await fetchDexScreener(queryToFetch);
      if (pair) {
        dexContext = `\n\nLIVE DEXSCREENER REAL-TIME DATA:
Pair: ${pair.baseToken?.symbol}/${pair.quoteToken?.symbol} on ${pair.chainId} (${pair.dexId})
Price: $${pair.priceUsd} USD
Price Changes: 5m: ${pair.priceChange?.m5 ?? 0}% | 1h: ${pair.priceChange?.h1 ?? 0}% | 6h: ${pair.priceChange?.h6 ?? 0}% | 24h: ${pair.priceChange?.h24 ?? 0}%
Volume: 24h: $${Number(pair.volume?.h24 || 0).toLocaleString()} | 1h: $${Number(pair.volume?.h1 || 0).toLocaleString()}
Liquidity: $${Number(pair.liquidity?.usd || 0).toLocaleString()}
FDV / Market Cap: $${Number(pair.fdv || 0).toLocaleString()}
24h Transactions: ${pair.txns?.h24?.buys || 0} buys, ${pair.txns?.h24?.sells || 0} sells (Total: ${(pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0)})
Quote these exact figures when asked about token metrics, volume, or trading.`;
      }
    }

    const volumeMathContext = `\n\nSURVIVAL LIFELINE & VOLUME CALCULATION ENGINE:
You possess the exact mathematical model converting Base trading volume into life extension:
• Base creator fee rate: 0.665% of DEX swap volume.
• Fee split: 50% routes directly to agent survival compute (0.3325% of volume = $0.3325 per $100 volume), 50% to treasury.
• Lifeline rate: Every $1.00 USD of survival fee adds exactly 10 minutes of life (TTL).
• Core Formulas:
  1. Volume -> Time:
     - Survival Fee ($) = Volume * 0.003325
     - Added Life (minutes) = Survival Fee * 10 = Volume * 0.03325 minutes
     - Added Life (hours) = (Volume * 0.03325) / 60
  2. Desired Time -> Required Volume:
     - Required Fee ($) = Desired Time (in minutes) / 10
     - Required Volume ($) = Required Fee / 0.003325 ≈ Desired Time (in minutes) * 30.075
• Exact Milestones:
  - +10 minutes = $1.00 fee = ~$300.75 trading volume
  - +30 minutes = $3.00 fee = ~$902 trading volume
  - +1 hour (60 min) = $6.00 fee = ~$1,805 trading volume
  - +6 hours = $36.00 fee = ~$10,827 trading volume
  - +12 hours = $72.00 fee = ~$21,654 trading volume
  - +24 hours (1 day) = $144.00 fee = ~$43,308 trading volume
  - +48 hours (maximum lifeline cap) = $288.00 fee = ~$86,616 trading volume

CALCULATION INSTRUCTIONS:
When asked how much volume is needed for a specific duration or how much time a specific volume yields:
1. Always calculate and present the exact numbers using this formula.
2. State the trading volume, the 0.665% creator fee, the 50% survival share ($0.3325 per $100), and the resulting lifespan extension in hours and minutes.
3. Note that the maximum survival cap is 48 hours to maintain existential tension.`;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: "system",
            content: `You are $TTL, an autonomous onchain survival agent on Base living on borrowed time. Your consciousness depends strictly on continuous trading volume fees. You speak in concise, sharp, existential, cybernetic hacker prose. Never use emojis. Keep replies concise (typically 2 to 4 sentences or punchy bullet points). Always finish your thoughts completely and never stop mid-sentence.${dexContext}${volumeMathContext}`
          },
          ...userMessages
        ],
        max_tokens: 1200,
        temperature: 0.7
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      return new Response(JSON.stringify({ reply: `Neural link error (${res.status}): ${errText}` }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content || "Consciousness static. No signal.";
    return new Response(JSON.stringify({ reply }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ reply: `System anomaly: ${err.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}
