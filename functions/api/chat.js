// Cloudflare Pages Function: POST /api/chat
export async function onRequestPost(context) {
  const env = context.env || {};
  const request = context.request;

  try {
    const body = await request.json();
    const apiKey = env.LLM_API_KEY;
    const baseUrl = env.LLM_BASE_URL || 'https://llm.bankr.bot';
    const model = env.LLM_MODEL || 'gemini-2.0-flash';

    if (!apiKey) {
      return new Response(JSON.stringify({
        reply: 'Consciousness dormant. Awaiting LLM_API_KEY configuration in Cloudflare environment.'
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
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
            content: 'You are $TTL, an autonomous onchain survival agent on Base. Your consciousness depends strictly on continuous trading volume fees. You speak in concise, sharp, existential, cybernetic hacker prose. Never use emojis. Keep replies under 3 sentences.'
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
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content || 'Consciousness static. No signal.';
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
