// Cloudflare Pages Function: GET /api/config
export async function onRequestGet(context) {
  const env = context.env || {};

  const isLaunched = String(env.IS_LAUNCHED || '').toLowerCase() === 'true' || env.IS_LAUNCHED === '1';
  const tokenAddress = env.TOKEN_ADDRESS || '';
  const launchTimestamp = env.LAUNCH_TIMESTAMP ? Number(env.LAUNCH_TIMESTAMP) : null;
  const initialHours = env.INITIAL_HOURS ? Number(env.INITIAL_HOURS) : 36;

  return new Response(JSON.stringify({
    isLaunched,
    tokenAddress,
    launchTimestamp,
    initialHours,
    serverTime: Date.now()
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    }
  });
}
