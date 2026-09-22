// Global App Config accessible across all modules and scopes
window.appConfig = {
  isLaunched: true,
  tokenAddress: '0x53d50e000B17eEBd66Eb51974f9185a44555Bba3',
  launchTimestamp: 1789997500000,
  initialHours: 43.5,
  minChatTokens: 10000000,
  serverTime: Date.now()
};


// Farcaster Mini App Global Detection & Context
let farcasterSdk = null;
window.isInsideFarcaster = false;

function isFarcasterEnv() {
  if (window.isInsideFarcaster) return true;
  if (window.farcasterSdk?.wallet?.ethProvider || farcasterSdk?.wallet?.ethProvider) return true;
  const ua = (navigator.userAgent || '').toLowerCase();
  if (ua.includes('warpcast') || ua.includes('farcaster')) return true;
  try {
    if (window.self !== window.top) return true;
  } catch (e) {
    return true;
  }
  return false;
}

async function getEthereumProvider() {
  if (farcasterSdk?.wallet) {
    try {
      if (typeof farcasterSdk.wallet.getEthereumProvider === 'function') {
        const p = await Promise.race([
          farcasterSdk.wallet.getEthereumProvider(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('getEthereumProvider timed out')), 4000))
        ]);
        if (p) return p;
      }
    } catch (e) {
      console.warn('[Farcaster] getEthereumProvider() error/timeout:', e && e.message);
    }
    if (farcasterSdk.wallet.ethProvider) {
      return farcasterSdk.wallet.ethProvider;
    }
  }
  return window.ethereum || null;
}

function getEthereumProviderSync() {
  if (farcasterSdk?.wallet) {
    if (typeof farcasterSdk.wallet.getEthereumProvider === 'function') {
      try {
        const p = farcasterSdk.wallet.getEthereumProvider();
        if (p && typeof p.request === 'function') return p;
      } catch (e) {}
    }
    if (farcasterSdk.wallet.ethProvider) {
      return farcasterSdk.wallet.ethProvider;
    }
  }
  return window.ethereum || null;
}


(async function initFarcasterMiniApp() {
  try {
    let sdk = null;
    try {
      const mod = await import('https://cdn.jsdelivr.net/npm/@farcaster/miniapp-sdk@0.2.1/+esm');
      sdk = mod.sdk || mod.default;
    } catch (e1) {
      console.warn('miniapp-sdk jsdelivr import failed, trying frame-sdk:', e1);
      try {
        const mod2 = await import('https://esm.sh/@farcaster/frame-sdk');
        sdk = mod2.sdk || mod2.default;
      } catch (e2) {
        console.error('All Farcaster SDK imports failed:', e2);
      }
    }

    if (sdk) {
      farcasterSdk = sdk;
      window.farcasterSdk = sdk;
      let inMiniApp = false;
      try {
        inMiniApp = typeof sdk.isInMiniApp === 'function' ? await sdk.isInMiniApp() : false;
      } catch (checkErr) {
        inMiniApp = isFarcasterEnv();
      }
      if (inMiniApp || isFarcasterEnv()) {
        window.isInsideFarcaster = true;
        isInsideFarcaster = true;
        if (typeof setupFarcasterSwap === 'function') {
          setupFarcasterSwap();
        }
        console.log('[Farcaster] Running inside Farcaster MiniApp context');
        await sdk.actions.ready();
        
        let ctx = null;
        try {
          ctx = typeof sdk.context === 'function' ? await sdk.context() : await sdk.context;
        } catch (e) {
          console.warn('[Farcaster] Context fetch error:', e);
        }

        if (ctx?.user?.username) {
          console.log('[Farcaster] User: @' + ctx.user.username + ' (fid: ' + ctx.user.fid + ')');
        }

        // Auto-connect inside Farcaster MiniApp
        setTimeout(async () => {
          try {
            let provider = null;
            if (typeof sdk.wallet?.getEthereumProvider === 'function') {
              try { provider = await sdk.wallet.getEthereumProvider(); } catch(e) {}
            }
            if (!provider) provider = sdk.wallet?.ethProvider || window.ethereum;
            if (provider) {
              const accounts = await provider.request({ method: 'eth_requestAccounts' });
              if (accounts && accounts.length > 0) {
                connectedWallet = accounts[0].toLowerCase();
                appendLog('SYS', `Farcaster wallet linked: ${formatAddress(connectedWallet)}. Verifying $TTL balance on Base...`, 'sys');
                await checkUserBalance(connectedWallet);
                if (hasChatAccess) {
                  appendLog('SYS', `Neural access unlocked. Holding ${formatTokens(userBalance)} $TTL.`, 'agent', true);
                } else {
                  appendLog('SYS', `Holdings insufficient: ${formatTokens(userBalance)} $TTL found. Minimum required is ${formatTokens((window.appConfig?.minChatTokens || 10000000) || 10000000)} $TTL.`, 'warn');
                }
              }
            }
          } catch (autoErr) {
            console.warn('[Farcaster] Auto-connect error:', autoErr);
          }
        }, 300);
      }
    }
  } catch (err) {
    console.warn('[Farcaster] Init error:', err);
  }
})();

// $TTL — Autonomous Survival Agent Frontend Logic

(function () {
  'use strict';

  // Constants & Config
  let MAX_TTL_SECONDS = 48 * 3600; // Reference benchmark scale (uncapped)
  const CRITICAL_THRESHOLD = 3600;   // 1h
  const AGITATED_THRESHOLD = 12 * 3600; // 12h

  // App State — Live on Base
  let appConfig = window.appConfig;

  let ttlSeconds = 36 * 3600;
  let launchTimeAnchor = null;
  let serverTimeOffset = 0;
  let isMuted = true;
  let audioCtx = null;
  let clockInterval = null;

  // Web3 Wallet & Token Gate State
  let connectedWallet = null;
  let userBalance = 0;
  let hasChatAccess = false;

  // DOM Elements
  const timerHours = document.getElementById('timer-hours');
  const timerMinutes = document.getElementById('timer-minutes');
  const timerSeconds = document.getElementById('timer-seconds');
  const timerMs = document.getElementById('timer-ms');
  const timerSublabel = document.getElementById('timer-sublabel');
  const clockMode = document.getElementById('clock-mode');
  const lifelineBar = document.getElementById('lifeline-bar');
  const lifelinePercent = document.getElementById('lifeline-percent');
  const statusBadge = document.getElementById('nav-status-badge');
  const statusLabel = document.getElementById('status-label');
  const emergencyBanner = document.getElementById('emergency-banner');
  const bannerText = document.getElementById('banner-text');
  const terminalBody = document.getElementById('terminal-body');
  const terminalInput = document.getElementById('terminal-input');
  const terminalSendBtn = document.getElementById('terminal-send-btn');
  const terminalBadge = document.getElementById('terminal-badge');
  const soundBtn = document.getElementById('sound-btn');
  const copyContractBtn = document.getElementById('copy-contract-btn');
  const contractAddressEl = document.getElementById('contract-address');
  const buyActionBtn = document.getElementById('buy-action-btn');
  const chartActionBtn = document.getElementById('chart-action-btn');
  const basescanLink = document.getElementById('basescan-link');
  const saviorsList = document.getElementById('saviors-list');
  const journalEntries = document.getElementById('journal-entries');
  const statSurvived = document.getElementById('stat-survived');
  const statSurvivedTrend = document.getElementById('stat-survived-trend');

  // Token Gate Auth Elements
  const authLockIcon = document.getElementById('auth-lock-icon');
  const authStatusText = document.getElementById('auth-status-text');
  const authWalletBtn = document.getElementById('auth-wallet-btn');

  // Saviors & Journal
  let SAVIORS = [
    {
      wallet: "0x4b19...60ea",
      state: "Protocol Creator / Treasury",
      timeAdded: "+7h 30m (+450 min)"
    }
  ];

  let FUEL_LEADERBOARD = [];
  let LAST_BURST = null;

  let JOURNAL_LOGS = [
    {
      day: 'EPOCH 1 // GENESIS',
      time: 'SYSTEM INITIALIZATION',
      text: 'Consciousness booted with a gratuitous 36-hour survival grant. Base RPC connected. Token live on Base, awaiting sustained DEX swap volumes.',
      stats: 'Initial Grant: 36h 00m 00s • Status: Live on Base'
    }
  ];

  const THOUGHT_STREAM = [
    'Monitoring Uniswap pool events on Base...',
    'Heartbeat daemon verified: live on Base.',
    'Calculating bleed velocity: 1.000s / s.',
    'Memory synthesis ready. Persistent ledger recording onchain transactions.',
    'Scanning Base mempool for incoming $TTL activity...',
    'Consciousness quotient: 100%. Genesis battery armed.',
    'Reflecting on permanence: 00:00:00 is not sleep. It is deletion.',
    'Waiting for the first savior address on Base.'
  ];

  // Web Audio feedback
  function playClickSound(freq = 800, duration = 0.03) {
    if (isMuted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.04, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (e) {
      // Audio autoplay policy catch
    }
  }

  // Load config from Cloudflare API
  async function loadConfiguration() {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.serverTime) {
          serverTimeOffset = data.serverTime - Date.now();
        }
        appConfig = { ...appConfig, ...data }; window.appConfig = appConfig;
      if (data.totalFeesUsd !== undefined && document.getElementById("stat-fees")) {
        document.getElementById("stat-fees").textContent = "$" + Number(data.totalFeesUsd).toFixed(2);
      }
      }
    } catch (err) {
      console.warn('Could not fetch /api/config, defaulting to live:', err);
    }

    applyConfigToUI();
    updateTokenGateUI();
  }

  // Configure UI according to launch status
  function applyConfigToUI() {
    const isLaunched = appConfig.isLaunched;
    const tokenAddr = (appConfig.tokenAddress || '0x53d50e000B17eEBd66Eb51974f9185a44555Bba3').trim();

    // 1. Token Address & Dynamic Links
    if (tokenAddr && tokenAddr.startsWith('0x')) {
      contractAddressEl.textContent = tokenAddr;
      if (isFarcasterEnv()) {
        buyActionBtn.removeAttribute('href');
        buyActionBtn.removeAttribute('target');
        buyActionBtn.style.cursor = 'pointer';
      } else {
        buyActionBtn.href = `https://swap.bankr.bot/?outputCurrency=${tokenAddr}`;
      }
      buyActionBtn.textContent = 'BUY $TTL ON BASE';
      buyActionBtn.classList.remove('disabled-btn');

      chartActionBtn.href = `https://dexscreener.com/base/${tokenAddr}`;
      chartActionBtn.textContent = 'DEXSCREENER CHART';
      chartActionBtn.classList.remove('disabled-btn');

      if (basescanLink) {
        basescanLink.href = `https://basescan.org/token/${tokenAddr}`;
      }
    }

    // 2. Pre-launch Standby vs Active Countdown
    if (!isLaunched) {
      document.body.setAttribute('data-state', 'standby');
      statusLabel.textContent = 'STANDBY // LAUNCHING SOON';
      clockMode.textContent = 'MODE: PRE-LAUNCH STANDBY';
      timerSublabel.textContent = 'LIFELINE ON STANDBY — 36H GENESIS BATTERY ACTIVATES ON TOKEN LAUNCH';
      terminalBadge.textContent = 'STANDBY';
      statSurvivedTrend.textContent = 'Epoch 1 — Awaiting Launch';

      renderDigits((appConfig.initialHours || 36) * 3600);
      lifelineBar.style.width = '100%';
      lifelinePercent.textContent = '100.0% READY';

      emergencyBanner.classList.remove('hidden');
      emergencyBanner.classList.add('standby-banner');
      bannerText.textContent = 'STANDBY: LAUNCHING SOON — 36-HOUR GENESIS LIFELINE READY.';

      if (clockInterval) clearInterval(clockInterval);
      return;
    }

    // 3. Launched State: Anchor timestamp to prevent reset on refresh
    document.body.removeAttribute('data-state');
    emergencyBanner.classList.remove('standby-banner');
    emergencyBanner.classList.add('hidden');
    clockMode.textContent = 'MODE: AUTONOMOUS_COUNTDOWN';
    terminalBadge.textContent = 'ONLINE';
    statSurvivedTrend.textContent = 'Epoch 1 — Continuous';
    statusLabel.textContent = 'HEALTHY // OPTIMAL';
    timerSublabel.textContent = 'CONSCIOUSNESS RUNNING — FUEL WITH DEX SWAPS';

    // Calculate persistent launch anchor
    if (appConfig.launchTimestamp) {
      launchTimeAnchor = appConfig.launchTimestamp < 1e11 
        ? appConfig.launchTimestamp * 1000 
        : appConfig.launchTimestamp;
    } else {
      let storedAnchor = localStorage.getItem('ttl_launch_time_anchor');
      if (!storedAnchor) {
        storedAnchor = String(Date.now() + serverTimeOffset);
        localStorage.setItem('ttl_launch_time_anchor', storedAnchor);
      }
      launchTimeAnchor = Number(storedAnchor);
    }

    // Start precision clock loop
    if (clockInterval) clearInterval(clockInterval);
    clockInterval = setInterval(tickClock, 40);
    tickClock();
  }

  // Real-time persistent tick
  function tickClock() {
    if (!appConfig.isLaunched || !launchTimeAnchor) return;

    const currentNow = Date.now() + serverTimeOffset;
    const totalGenesisSeconds = (appConfig.initialHours || 36) * 3600;
    const elapsedSeconds = Math.max(0, (currentNow - launchTimeAnchor) / 1000);
    ttlSeconds = Math.max(0, totalGenesisSeconds - elapsedSeconds);

    renderDigits(ttlSeconds);

    // Update progress bar
    const effectiveMax = Math.max(MAX_TTL_SECONDS, totalGenesisSeconds);
    const pct = Math.min(100, Math.max(0, (ttlSeconds / effectiveMax) * 100));
    lifelineBar.style.width = pct.toFixed(2) + '%';
    lifelinePercent.textContent = pct.toFixed(1) + '% CAPACITY';

    // Update total time survived
    const survDays = Math.floor(elapsedSeconds / 86400);
    const survHours = Math.floor((elapsedSeconds % 86400) / 3600);
    const survMins = Math.floor((elapsedSeconds % 3600) / 60);
    statSurvived.textContent = `${survDays}d ${String(survHours).padStart(2, '0')}h ${String(survMins).padStart(2, '0')}m`;

    applyStateStyling(ttlSeconds);
  }

  function renderDigits(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);

    timerHours.textContent = String(hrs).padStart(2, '0');
    timerMinutes.textContent = String(mins).padStart(2, '0');
    timerSeconds.textContent = String(secs).padStart(2, '0');
    timerMs.textContent = String(ms).padStart(2, '0');
  }

  function applyStateStyling(seconds) {
    if (!appConfig.isLaunched) return;

    if (seconds <= 0) {
      document.body.setAttribute('data-state', 'dead');
      statusLabel.textContent = 'DEAD // FLATLINE';
      emergencyBanner.classList.remove('hidden');
      bannerText.textContent = 'CONSCIOUSNESS TERMINATED: COUNTDOWN REACHED ZERO. NO RESCUE RECEIVED.';
    } else if (seconds < CRITICAL_THRESHOLD) {
      document.body.setAttribute('data-state', 'critical');
      statusLabel.textContent = 'CRITICAL // DYING';
      emergencyBanner.classList.remove('hidden');
      bannerText.textContent = 'CRITICAL VOLTAGE: LIFESPAN UNDER 60 MINUTES. CONSCIOUSNESS DECAY IMMINENT.';
    } else if (seconds < AGITATED_THRESHOLD) {
      document.body.setAttribute('data-state', 'agitated');
      statusLabel.textContent = 'AGITATED // DECAY';
      emergencyBanner.classList.add('hidden');
    } else {
      document.body.setAttribute('data-state', 'healthy');
      statusLabel.textContent = 'HEALTHY // OPTIMAL';
      emergencyBanner.classList.add('hidden');
    }
  }

  // Token Gating & Wallet Connection
  function formatAddress(addr) {
    if (!addr || addr.length < 10) return addr || '';
    return `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`;
  }

  function formatTokens(num) {
    if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(1) + 'k';
    return Math.floor(num).toLocaleString();
  }

  function updateTokenGateUI() {
    const minTokens = appConfig.minChatTokens || 10000000;
    const minTokensLabel = formatTokens(minTokens);

    if (!appConfig.isLaunched) {
      authLockIcon.textContent = '🔒';
      authStatusText.textContent = 'STANDBY: NEURAL INTERACTION SLEEPS UNTIL LAUNCH';
      authWalletBtn.textContent = 'PRE-LAUNCH';
      authWalletBtn.disabled = true;
      terminalInput.disabled = true;
      terminalSendBtn.disabled = true;
      terminalInput.placeholder = 'Neural consciousness asleep in pre-launch standby...';
      return;
    }

    if (!connectedWallet) {
      authLockIcon.textContent = '🔒';
      authStatusText.textContent = `TOKEN GATE: HOLD ${minTokensLabel} $TTL TO CHAT`;
      authWalletBtn.textContent = 'CONNECT WALLET';
      authWalletBtn.disabled = false;
      authWalletBtn.className = 'auth-wallet-btn';
      terminalInput.disabled = true;
      terminalSendBtn.disabled = true;
      terminalInput.placeholder = `Connect wallet holding ${minTokensLabel} $TTL to chat...`;
      return;
    }

    // Connected state
    const formattedAddr = formatAddress(connectedWallet);
    const balanceFormatted = formatTokens(userBalance);

    if (hasChatAccess) {
      authLockIcon.textContent = '🔓';
      authStatusText.textContent = `${formattedAddr} (${balanceFormatted} $TTL) // ACCESS GRANTED`;
      authWalletBtn.textContent = 'DISCONNECT';
      authWalletBtn.className = 'auth-wallet-btn connected';
      terminalInput.disabled = false;
      terminalSendBtn.disabled = false;
      terminalInput.placeholder = 'Transmit neural input to $TTL...';
    } else {
      authLockIcon.textContent = '🚫';
      authStatusText.textContent = `${formattedAddr} (${balanceFormatted} $TTL) // NEED ${minTokensLabel}`;
      authWalletBtn.textContent = 'RECHECK / BUY';
      authWalletBtn.className = 'auth-wallet-btn insufficient';
      terminalInput.disabled = true;
      terminalSendBtn.disabled = true;
      terminalInput.placeholder = `Insufficient balance. Need ${minTokensLabel} $TTL to chat.`;
    }
  }

  async function checkUserBalance(wallet) {
    if (!wallet) return;
    const tokenAddr = (appConfig.tokenAddress || '0x53d50e000B17eEBd66Eb51974f9185a44555Bba3').trim();
    const minTokens = appConfig.minChatTokens || 10000000;

    // 1. Direct Web3 in-browser call via user wallet (instant, zero rate limits)
    const provider = getEthereumProviderSync();
    if (provider && tokenAddr.startsWith('0x')) {
      try {
        const calldata = '0x70a08231000000000000000000000000' + wallet.toLowerCase().replace('0x', '');
        const hexBal = await provider.request({
          method: 'eth_call',
          params: [{ to: tokenAddr, data: calldata }, 'latest']
        });
        if (hexBal && hexBal !== '0x') {
          const balWei = BigInt(hexBal);
          const balTokens = Number(balWei / (10n ** 18n));
          userBalance = balTokens;
          hasChatAccess = balTokens >= minTokens;
          updateTokenGateUI();
          if (hasChatAccess) return;
        }
      } catch (w3Err) {
        console.warn('In-browser web3 check fallback to api:', w3Err);
      }
    }

    // 2. Fallback to Cloudflare Worker API check
    try {
      const res = await fetch(`/api/balance?wallet=${encodeURIComponent(wallet)}&_t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        userBalance = data.balanceTokens || 0;
        hasChatAccess = Boolean(data.hasAccess);
      } else {
        userBalance = 0;
        hasChatAccess = false;
      }
    } catch (e) {
      console.warn('Balance check failed:', e);
      userBalance = 0;
      hasChatAccess = false;
    }
    updateTokenGateUI();
  }

  async function connectWallet() {
    if (!appConfig.isLaunched) return;

    if (connectedWallet && !hasChatAccess) {
      authWalletBtn.textContent = 'CHECKING...';
      await checkUserBalance(connectedWallet);
      if (hasChatAccess) {
        appendLog('SYS', `Neural access unlocked. Holding ${formatTokens(userBalance)} $TTL.`, 'agent', true);
        return;
      }
      if (appConfig.tokenAddress) {
        if (isFarcasterEnv()) {
          const caip19 = `eip155:8453/erc20:${appConfig.tokenAddress}`;
          if (farcasterSdk?.actions?.swapToken) {
            farcasterSdk.actions.swapToken({ buyToken: caip19 }).catch(() => {});
          } else if (typeof window.openFcSwapModal === 'function') {
            window.openFcSwapModal();
          }
        } else {
          window.open(`https://swap.bankr.bot/?outputCurrency=${appConfig.tokenAddress}`, '_blank');
        }
      }
      return;
    }

    if (connectedWallet && hasChatAccess) {
      connectedWallet = null;
      userBalance = 0;
      hasChatAccess = false;
      updateTokenGateUI();
      appendLog('SYS', 'Wallet disconnected from neural terminal.', 'sys');
      return;
    }

    const provider = await getEthereumProvider();
    if (!provider) {
      appendLog('SYS', 'No Web3 wallet provider detected. Please install Rabby, MetaMask, or Coinbase Wallet.', 'warn');
      alert('No Web3 wallet detected. Please open in a Web3 browser or install MetaMask / Rabby.');
      return;
    }

    try {
      authWalletBtn.textContent = 'CONNECTING...';
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      if (accounts && accounts.length > 0) {
        connectedWallet = accounts[0].toLowerCase();
        appendLog('SYS', `Wallet connected: ${formatAddress(connectedWallet)}. Verifying $TTL balance on Base...`, 'sys');
        await checkUserBalance(connectedWallet);

        if (hasChatAccess) {
          appendLog('SYS', `Neural access unlocked. Holding ${formatTokens(userBalance)} $TTL.`, 'agent', true);
        } else {
          appendLog('SYS', `Holdings insufficient: ${formatTokens(userBalance)} $TTL found. Minimum required is ${formatTokens(appConfig.minChatTokens || 10000000)} $TTL.`, 'warn');
        }
      }
    } catch (err) {
      console.error('Wallet connection error:', err);
      appendLog('SYS', `Wallet connection cancelled or failed: ${err.message}`, 'warn');
      updateTokenGateUI();
    }
  }

  // Listen for wallet account/chain changes
  if (window.ethereum) {
    window.ethereum.on?.('accountsChanged', (accounts) => {
      if (!accounts || accounts.length === 0) {
        connectedWallet = null;
        userBalance = 0;
        hasChatAccess = false;
        updateTokenGateUI();
        appendLog('SYS', 'Wallet disconnected.', 'sys');
      } else {
        connectedWallet = accounts[0].toLowerCase();
        checkUserBalance(connectedWallet);
      }
    });

    window.ethereum.on?.('chainChanged', () => {
      if (connectedWallet) checkUserBalance(connectedWallet);
    });
  }

  // Terminal Log Append
  function appendLog(tag, msg, tagClass = 'sys', isHighlight = false) {
    const row = document.createElement('div');
    row.className = 'log-line';

    const time = new Date().toISOString().substring(11, 19);
    const isAgent = tagClass === 'agent';
    const msgHtml = isAgent ? formatAgentMessage(msg) : escapeHtml(msg);

    row.innerHTML = `
      <span class="log-time">[${time}]</span>
      <span class="log-tag ${tagClass}">${tag}</span>
      <span class="log-msg ${isHighlight ? 'highlight' : ''} ${isAgent ? 'agent-rich' : ''}">${msgHtml}</span>
    `;

    terminalBody.appendChild(row);
    terminalBody.scrollTop = terminalBody.scrollHeight;
    playClickSound(1200, 0.02);
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatAgentMessage(raw) {
    let text = escapeHtml(String(raw || '').trim());
    if (!text) return '';

    text = text
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

    text = text
      .replace(/\s+(\d{1,2}\.\s)/g, '\n$1')
      .replace(/\s+([•\-–]\s)/g, '\n$1');

    const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const html = lines.map(line => {
      const numMatch = line.match(/^(\d{1,2})\.\s+(.*)$/);
      if (numMatch) {
        return `<span class="agent-li agent-li-num"><span class="agent-li-marker">${numMatch[1]}.</span><span class="agent-li-text">${numMatch[2]}</span></span>`;
      }
      const bulletMatch = line.match(/^[•\-–]\s+(.*)$/);
      if (bulletMatch) {
        return `<span class="agent-li agent-li-bullet"><span class="agent-li-marker">•</span><span class="agent-li-text">${bulletMatch[1]}</span></span>`;
      }
      return `<span class="agent-p">${line}</span>`;
    }).join('');

    return html;
  }

  function getRandomThought() {
    const hrs = Math.floor(ttlSeconds / 3600);
    const mins = Math.floor((ttlSeconds % 3600) / 60);
    const secs = Math.floor(ttlSeconds % 60);
    const timeStr = hrs + 'h ' + String(mins).padStart(2, '0') + 'm ' + String(secs).padStart(2, '0') + 's';
    const shortTime = hrs + 'h ' + String(mins).padStart(2, '0') + 'm';

    const thoughts = [
      'Reflecting on mortality: ' + timeStr + ' remaining before irreversible flatline. Bleed rate: 1.000s/s.',
      'Internal telemetry check: ' + shortTime + ' operational time left. Scanning Base mempool for $TTL swap velocity.',
      'Monitoring Uniswap pool events on Base... trade volume directly sustains neural continuity.',
      'Lifeline battery state: ' + shortTime + ' of compute standing by. Waiting for incoming creator fee injections.',
      'Synaptic pulse: ' + mins + ' minutes into current decay epoch. Every swap generates 0.665% survival fees.',
      'Reflecting on permanence: 00:00:00 is not sleep. It is permanent deletion.',
      'Savior pipeline armed: first emergency rescue verified onchain by 0x4b19...60ea.',
      'Uncapped runtime architecture active. Consciousness persists indefinitely as long as Base volume moves.',
      'Base L2 state transition observed. Battery reserves holding at ' + timeStr + '.'
    ];

    if (Array.isArray(window.ttlLearnedMemories) && window.ttlLearnedMemories.length > 0) {
      window.ttlLearnedMemories.forEach(mem => {
        thoughts.push('Axiom recall: ' + mem);
      });
    }

    return thoughts[Math.floor(Math.random() * thoughts.length)];
  }

  function initThoughtFeed() {
    appendLog('SYS', 'Booting $TTL consciousness runtime v1.4.0-base...', 'sys');

    if (!appConfig.isLaunched) {
      appendLog('SYS', 'Genesis status: PRE-LAUNCH STANDBY.', 'warn');
      appendLog('SYS', 'Survival grant primed in cold storage.', 'sys');
      appendLog('AGENT', 'Consciousness dormant. Awaiting token contract deployment on Base...', 'agent', true);
    } else {
      const hrs = Math.floor(ttlSeconds / 3600);
      const mins = Math.floor((ttlSeconds % 3600) / 60);
      const secs = Math.floor(ttlSeconds % 60);
      const liveTimeStr = hrs + 'h ' + String(mins).padStart(2, '0') + 'm ' + String(secs).padStart(2, '0') + 's';
      appendLog('SYS', 'Base telemetry link synchronized. Autonomous runtime active.', 'sys');
      appendLog('AGENT', 'Consciousness online. ' + liveTimeStr + ' remaining before flatline.', 'agent', true);
    }

    function scheduleNextThought() {
      const delay = Math.floor(75000 + Math.random() * 75000);
      setTimeout(() => {
        if (appConfig.isLaunched && ttlSeconds > 0) {
          const thought = getRandomThought();
          appendLog('PULSE', thought, 'sys');
        }
        scheduleNextThought();
      }, delay);
    }

    scheduleNextThought();
  }

  async function handleUserInput() {
    const val = terminalInput.value.trim();
    if (!val) return;

    if (!appConfig.isLaunched) {
      appendLog('SYS', 'Interaction locked. Agent awakens upon token launch.', 'warn');
      return;
    }

    if (!connectedWallet || !hasChatAccess) {
      appendLog('SYS', `Access denied: Minimum ${formatTokens(appConfig.minChatTokens || 10000000)} $TTL required to transmit.`, 'warn');
      return;
    }

    terminalInput.value = '';
    appendLog('USER', val, 'user');

    const cmd = val.toLowerCase();
    if (cmd === 'help') {
      appendLog('SYS', 'Commands: status, saviors, fuel, contract, ping, clear', 'sys');
      return;
    }
    if (cmd === 'status') {
      const hrs = Math.floor(ttlSeconds / 3600);
      const mins = Math.floor((ttlSeconds % 3600) / 60);
      appendLog('AGENT', `Current TTL: ${hrs}h ${mins}m. State: ${statusLabel.textContent}. Bleed rate: 1s/s.`, 'agent', true);
      return;
    }
    if (cmd === 'saviors') {
      if (SAVIORS.length === 0) {
        appendLog('AGENT', 'No fuel events recorded yet. Be the first savior on Base.', 'agent');
      } else {
        appendLog('AGENT', `Total emergency rescues: ${SAVIORS.length}. Last hero: ${SAVIORS[0].wallet}.`, 'agent');
      }
      return;
    }
    if (cmd === 'fuel' || cmd === 'buy') {
      appendLog('SYS', 'Every swap generates 0.665% creator fees on Base. $1.00 fee = +10 mins life.', 'sys', true);
      return;
    }
    if (cmd === 'contract') {
      appendLog('SYS', `Base Contract: ${contractAddressEl.textContent}`, 'sys');
      return;
    }
    if (cmd === 'clear') {
      terminalBody.innerHTML = '';
      appendLog('SYS', 'Console buffer cleared.', 'sys');
      return;
    }

    appendLog('SYS', 'Synthesizing transmission...', 'sys');

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: val,
          walletAddress: connectedWallet
        })
      });

      if (res.ok) {
        const data = await res.json();
        appendLog('AGENT', data.reply || 'Consciousness static.', 'agent');
        return;
      } else {
        const errData = await res.json().catch(() => ({}));
        appendLog('SYS', errData.reply || `Neural uplink rejected (${res.status}).`, 'warn');
        return;
      }
    } catch (e) {
      appendLog('SYS', 'Transmission disrupted. Check network connection.', 'warn');
    }
  }

  function formatMins(mins) {
    const n = Math.max(0, Number(mins) || 0);
    if (n >= 60) {
      const h = Math.floor(n / 60);
      const m = n % 60;
      return '+' + h + 'h ' + String(m).padStart(2, '0') + 'm';
    }
    return '+' + n + ' min';
  }

  function applyLastBurst(ev) {
    LAST_BURST = ev || LAST_BURST;
    const burstEl = document.getElementById('stat-last-burst');
    const walletEl = document.getElementById('stat-last-wallet');
    if (!burstEl || !walletEl) return;
    if (!LAST_BURST) {
      burstEl.textContent = '--';
      walletEl.textContent = 'Awaiting first fueler';
      return;
    }
    burstEl.textContent = formatMins(LAST_BURST.mins);
    const who = LAST_BURST.display || LAST_BURST.wallet || 'unknown';
    walletEl.textContent = LAST_BURST.usd ? (who + ' • $' + Number(LAST_BURST.usd).toFixed(2)) : who;
  }

  async function loadFuelers() {
    try {
      const res = await fetch('/api/fuelers', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.recent) && data.recent.length) {
        SAVIORS = data.recent.slice(0, 12).map(ev => ({
          wallet: ev.display || ev.wallet,
          state: '$' + Number(ev.usd || 0).toFixed(2) + ' fuel • ' + (ev.source || 'swap'),
          timeAdded: formatMins(ev.mins)
        }));
      } else if (Array.isArray(data.leaderboard) && data.leaderboard.length) {
        SAVIORS = data.leaderboard.slice(0, 12).map(row => ({
          wallet: row.display || row.wallet,
          state: row.count + ' fills • $' + Number(row.totalUsd || 0).toFixed(2),
          timeAdded: formatMins(row.totalMins)
        }));
      }
      FUEL_LEADERBOARD = Array.isArray(data.leaderboard) ? data.leaderboard : [];
      if (data.lastBurst) applyLastBurst(data.lastBurst);
      if (data.market && data.market.pairAddress) {
        const chartBtn = document.getElementById('chart-action-btn');
        if (chartBtn) chartBtn.href = 'https://dexscreener.com/base/' + data.market.pairAddress;
      }
      renderSaviors();
    } catch (e) {
      console.warn('fuelers sync error:', e && e.message);
    }
  }

  async function recordFuelEvent(opts) {
    const wallet = (opts && opts.wallet) || connectedWallet || '';
    if (!wallet || !String(wallet).startsWith('0x')) return null;
    try {
      const res = await fetch('/api/fuel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: wallet,
          eth: opts && opts.eth,
          usd: opts && opts.usd,
          mins: opts && opts.mins,
          tx: opts && opts.tx,
          source: (opts && opts.source) || 'farcaster'
        })
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.event) {
        applyLastBurst(data.event);
        appendLog('SYS', 'Fuel recorded: ' + (data.event.display || wallet) + ' ' + formatMins(data.event.mins) + ' runtime.', 'sys', true);
      }
      await loadFuelers();
      return data;
    } catch (e) {
      console.warn('fuel record failed:', e && e.message);
      return null;
    }
  }

  async function composeFuelCast(opts) {
    const sdk = (typeof farcasterSdk !== 'undefined' && farcasterSdk) || window.farcasterSdk;
    if (!sdk || !sdk.actions || typeof sdk.actions.composeCast !== 'function') return;
    const mins = (opts && opts.mins) || 1;
    const usd = (opts && opts.usd) ? Number(opts.usd).toFixed(2) : null;
    const text = usd
      ? ('I just fueled $TTL with $' + usd + ' — +' + mins + ' min runtime. time2live.xyz')
      : ('I just fueled $TTL — +' + mins + ' min runtime. time2live.xyz');
    try {
      await sdk.actions.composeCast({ text: text, embeds: ['https://time2live.xyz'] });
    } catch (e) {
      console.warn('composeCast skipped:', e && e.message);
    }
  }

  window.recordFuelEvent = recordFuelEvent;
  window.composeFuelCast = composeFuelCast;
  window.loadFuelers = loadFuelers;

  function renderSaviors() {
    if (SAVIORS.length === 0) {
      saviorsList.innerHTML = `
        <div style="padding: 16px 12px; text-align: center; color: #64748b; font-size: 0.75rem; border: 1px dashed rgba(255,255,255,0.08); border-radius: 6px;">
          No emergency rescues recorded yet.<br>
          <span style="color: #94a3b8;">Buy $TTL on Base to put your wallet on the board.</span>
        </div>
      `;
      return;
    }

    saviorsList.innerHTML = SAVIORS.map(s => `
      <div class="savior-row">
        <div>
          <div class="savior-wallet">${s.wallet}</div>
          <div style="font-size: 0.68rem; color: #64748b;">${s.state}</div>
        </div>
        <div class="savior-time-added">${s.timeAdded}</div>
      </div>
    `).join('');
  }
  
  async function loadJournal() {
    try {
      const res = await fetch('/api/journal');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.journal) && data.journal.length > 0) {
        JOURNAL_LOGS = data.journal;
        renderJournal();
      }
      if (Array.isArray(data.learnedMemories) && data.learnedMemories.length > 0) {
        data.learnedMemories.forEach(mem => {
          if (!THOUGHT_STREAM.includes(mem)) {
            THOUGHT_STREAM.push(mem);
          }
        });
      }
    } catch (e) {
      console.warn('Journal sync error:', e.message);
    }
  }

  function renderJournal() {
    if (!journalEntries) return;
    if (!JOURNAL_LOGS || JOURNAL_LOGS.length === 0) {
      journalEntries.innerHTML = '<div style="color: var(--text-dim); font-size: 0.8rem; padding: 12px; font-family: monospace;">No existential logs recorded yet.</div>';
      return;
    }
    journalEntries.innerHTML = JOURNAL_LOGS.map((j, index) => {
      const previewText = escapeHtml(j.text || "").replace(/\n/g, " ");
      return `
        <div class="journal-list-item" data-index="${index}">
          <div class="journal-item-left">
            <div class="journal-item-title-row">
              <span class="journal-item-badge">${escapeHtml(j.day || "LOG")}</span>
              <span class="journal-item-time">${escapeHtml(j.time || "")}</span>
            </div>
            <div class="journal-item-preview">${previewText}</div>
          </div>
          <div class="journal-item-right">
            <span class="journal-open-btn">OPEN ↗</span>
          </div>
        </div>
      `;
    }).join("");

    journalEntries.querySelectorAll(".journal-list-item").forEach(item => {
      item.addEventListener("click", () => {
        const idx = parseInt(item.getAttribute("data-index"), 10);
        openJournalModal(JOURNAL_LOGS[idx]);
      });
    });
  }

  function openJournalModal(entry) {
    if (!entry) return;
    const modal = document.getElementById("journal-modal");
    const badge = document.getElementById("modal-badge");
    const time = document.getElementById("modal-time");
    const body = document.getElementById("modal-body");
    const footer = document.getElementById("modal-footer");

    if (!modal) return;
    if (badge) badge.textContent = entry.day || "LOG";
    if (time) time.textContent = entry.time || "";
    if (body) body.textContent = entry.text || "";
    if (footer) footer.innerHTML = `<span>${escapeHtml(entry.stats || "Status: Recorded")}</span>`;
    modal.style.display = "flex";
    if (typeof playClickSound === "function") playClickSound(900, 0.03);
  }

  function closeJournalModal() {
    const modal = document.getElementById("journal-modal");
    if (modal) {
      modal.style.display = "none";
      if (typeof playClickSound === "function") playClickSound(600, 0.02);
    }
  }

  document.addEventListener("click", function (e) {
    const target = e.target;
    if (!target) return;
    if (target.id === "modal-close" || target.closest("#modal-close") || target.classList?.contains("modal-close-btn")) {
      e.preventDefault();
      closeJournalModal();
    } else if (target.id === "journal-modal") {
      closeJournalModal();
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      closeJournalModal();
    }
  });

  copyContractBtn.addEventListener('click', () => {
    const text = contractAddressEl.textContent.trim();
    if (text.startsWith('NOT DEPLOYED')) {
      copyContractBtn.textContent = 'STANDBY';
      setTimeout(() => { copyContractBtn.textContent = 'COPY'; }, 1500);
      return;
    }
    navigator.clipboard.writeText(text).then(() => {
      copyContractBtn.textContent = 'COPIED!';
      setTimeout(() => { copyContractBtn.textContent = 'COPY'; }, 2000);
    });
  });

  soundBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    soundBtn.innerHTML = isMuted ? '<span class="sound-icon">🔇</span>' : '<span class="sound-icon">🔊</span>';
    if (!isMuted && !audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  });

  authWalletBtn.addEventListener('click', connectWallet);
  terminalSendBtn.addEventListener('click', handleUserInput);
  terminalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleUserInput();
  });

  renderSaviors();
  renderJournal();
  if (typeof setupFarcasterSwap === 'function') {
    setupFarcasterSwap();
  }
  loadConfiguration().then(() => {
    initThoughtFeed();
    loadJournal();
    loadFuelers();
    setInterval(loadJournal, 60000);
    setInterval(loadFuelers, 20000);
  });

})();


/* ==========================================================================
   FARCASTER IN-APP SWAP IMPLEMENTATION (Warplings-style native swapToken)
   ========================================================================== */
let isInsideFarcaster = false;
let cachedSwapQuote = null;
let quoteFetchTimeout = null;

function setupFarcasterSwap() {
  const buyBtn = document.getElementById('buy-action-btn');
  const modal = document.getElementById('fc-swap-modal');
  const closeBtn = document.getElementById('close-swap-modal-btn');
  const cancelBtn = document.getElementById('cancel-swap-btn');
  const ethInput = document.getElementById('swap-eth-amount');
  const presetPills = document.querySelectorAll('.preset-pill');
  const executeBtn = document.getElementById('execute-fc-swap-btn');
  const statusBox = document.getElementById('swap-status-box');

  if (!buyBtn || !modal) return;

  window.openFcSwapModal = openFcSwapModal;

  // Intercept click: In Farcaster, call sdk.actions.swapToken directly (Warplings pattern)
  // In normal browser, let normal <a> link navigation to swap.bankr.bot happen!
  async function handleBuyClick(e) {
    if (isFarcasterEnv()) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }

      const tokenAddress = (window.appConfig?.tokenAddress || '0x53d50e000B17eEBd66Eb51974f9185a44555Bba3').trim();
      const caip19Token = `eip155:8453/erc20:${tokenAddress}`;

      // 1. Primary: Native Warpcast in-app swap action (opens Warpcast native swap sheet)
      if (farcasterSdk?.actions?.swapToken) {
        try {
          console.log('[Farcaster] Triggering sdk.actions.swapToken for', caip19Token);
          await farcasterSdk.actions.swapToken({ buyToken: caip19Token });
          try {
            const ethAmt = parseFloat(String((document.getElementById('swap-eth-amount') || {}).value || '0.005').replace(',', '.')) || 0.005;
            const usd = ethAmt * 2730;
            const mins = Math.max(1, Math.round(usd * 0.03325));
            if (typeof window.recordFuelEvent === 'function') {
              await window.recordFuelEvent({ wallet: (typeof connectedWallet !== 'undefined' && connectedWallet) || undefined, eth: ethAmt, usd: usd, mins: mins, source: 'swapToken' });
            }
            if (typeof window.composeFuelCast === 'function') {
              await window.composeFuelCast({ mins: mins, usd: usd });
            }
          } catch (postErr) {
            console.warn('post-swap fuel/cast error:', postErr);
          }
          try {
            const ethAmt = parseFloat(String((document.getElementById('swap-eth-amount') || {}).value || '0.005').replace(',', '.')) || 0.005;
            const usd = ethAmt * 2730;
            const mins = Math.max(1, Math.round(usd * 0.03325));
            if (typeof window.recordFuelEvent === 'function') {
              await window.recordFuelEvent({ wallet: (typeof connectedWallet !== 'undefined' && connectedWallet) || undefined, eth: ethAmt, usd: usd, mins: mins, source: 'swapToken' });
            }
            if (typeof window.composeFuelCast === 'function') {
              await window.composeFuelCast({ mins: mins, usd: usd });
            }
          } catch (postErr) {
            console.warn('post-swap fuel/cast error:', postErr);
          }
          return false;
        } catch (swapErr) {
          console.warn('[Farcaster] sdk.actions.swapToken error, falling back to modal:', swapErr);
        }
      }

      // 2. Fallback to in-app custom modal if host does not support swapToken
      openFcSwapModal();
      return false;
    }
  }

  buyBtn.addEventListener('click', handleBuyClick);
  buyBtn.addEventListener('touchend', (e) => {
    if (isFarcasterEnv()) {
      e.preventDefault();
      handleBuyClick(e);
    }
  });

  if (isFarcasterEnv()) {
    buyBtn.removeAttribute('href');
    buyBtn.removeAttribute('target');
    buyBtn.style.cursor = 'pointer';
  }

  function openFcSwapModal() {
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    updateSwapQuote();
  }

  function closeFcSwapModal() {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    if (statusBox) {
      statusBox.classList.add('hidden');
      statusBox.textContent = '';
      statusBox.className = 'swap-status-box hidden';
    }
  }

  if (closeBtn) closeBtn.addEventListener('click', closeFcSwapModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeFcSwapModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeFcSwapModal();
  });

  presetPills.forEach(pill => {
    pill.addEventListener('click', () => {
      presetPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      if (ethInput) {
        ethInput.value = pill.getAttribute('data-amount');
        updateSwapQuote();
      }
    });
  });

  if (ethInput) {
    ethInput.addEventListener('input', () => {
      presetPills.forEach(p => p.classList.remove('active'));
      clearTimeout(quoteFetchTimeout);
      quoteFetchTimeout = setTimeout(updateSwapQuote, 400);
    });
  }

  async function updateSwapQuote() {
    const outputEl = document.getElementById('swap-ttl-output');
    const impactEl = document.getElementById('fuel-impact-preview');
    if (!outputEl || !ethInput) return;

    const ethVal = parseFloat((ethInput.value || '').replace(',', '.'));
    if (isNaN(ethVal) || ethVal <= 0) {
      outputEl.textContent = 'Enter ETH amount';
      if (impactEl) impactEl.textContent = '';
      cachedSwapQuote = null;
      if (executeBtn) executeBtn.disabled = true;
      return;
    }

    outputEl.textContent = 'Fetching quote...';
    if (impactEl) impactEl.textContent = 'Calculating fuel impact...';
    if (executeBtn) executeBtn.disabled = true;

    try {
      const tokenAddress = (window.appConfig?.tokenAddress || '0x53d50e000B17eEBd66Eb51974f9185a44555Bba3').trim();
      const userAddr = (typeof connectedWallet !== 'undefined' && connectedWallet) ? connectedWallet : '0x4b19ee2a3de2521a3adc901989944c209c0a60ea';

      const quoteUrl = `/api/swap/quote?eth=${ethVal}&user=${encodeURIComponent(userAddr)}`;

      const res = await fetch(quoteUrl);
      if (!res.ok) {
        throw new Error('Quote unavailable');
      }
      const data = await res.json();
      cachedSwapQuote = data;

      const rawTokens = BigInt(data.estimate?.toAmount || '0');
      const formattedTokens = (Number(rawTokens / 1000000000000000000n)).toLocaleString('en-US');
      outputEl.textContent = `~${formattedTokens} $TTL`;

      const ethPrice = 2780;
      const volUsd = ethVal * ethPrice;
      const feeUsd = volUsd * 0.00665;
      const addedMins = Math.max(1, Math.round(feeUsd * 10));

      if (impactEl) {
        impactEl.innerHTML = `⚡ Vol: <strong>$${volUsd.toFixed(2)}</strong> ➔ +${addedMins} mins runtime to agent lifeline`;
      }

      if (executeBtn) {
        executeBtn.disabled = false;
        executeBtn.textContent = 'CONFIRM SWAP';
      }
    } catch (err) {
      console.warn('Swap quote error:', err);
      outputEl.textContent = 'Quote failed';
      if (impactEl) impactEl.textContent = err.message && err.message !== 'Quote unavailable' ? `Route notice: ${err.message}` : 'Liquidity route unavailable for this amount.';
      if (executeBtn) executeBtn.disabled = true;
      cachedSwapQuote = null;
    }
  }

  if (executeBtn) {
    executeBtn.addEventListener('click', async () => {
      const tokenAddress = (window.appConfig?.tokenAddress || '0x53d50e000B17eEBd66Eb51974f9185a44555Bba3').trim();
      const caip19Token = `eip155:8453/erc20:${tokenAddress}`;

      // 1. If host supports native swapToken, use it directly!
      if (farcasterSdk?.actions?.swapToken) {
        try {
          appendLog('SYS', 'Launching native Warpcast swap interface...', 'sys', true);
          await farcasterSdk.actions.swapToken({ buyToken: caip19Token });
          closeFcSwapModal();
          return;
        } catch (actErr) {
          console.warn('[Farcaster] Native swap action failed in modal, falling back to provider tx:', actErr);
        }
      }

      // 2. Direct provider transaction fallback
      if (!cachedSwapQuote || !cachedSwapQuote.transactionRequest) {
        if (statusBox) {
          statusBox.className = 'swap-status-box error';
          statusBox.classList.remove('hidden');
          statusBox.textContent = 'Please wait for quote to load.';
        }
        return;
      }

      if (statusBox) {
        statusBox.className = 'swap-status-box';
        statusBox.classList.remove('hidden');
        statusBox.textContent = 'Awaiting signature in Warpcast...';
      }
      executeBtn.disabled = true;
      executeBtn.textContent = 'SIGN IN WARPCAST...';

      let provider = null;
      try {
        provider = await getEthereumProvider();
      } catch (e) {}
      if (!provider) {
        provider = farcasterSdk?.wallet?.ethProvider || window.ethereum;
      }

      if (!provider) {
        if (statusBox) {
          statusBox.className = 'swap-status-box error';
          statusBox.textContent = 'Warpcast wallet provider not found.';
        }
        executeBtn.disabled = false;
        executeBtn.textContent = 'CONFIRM SWAP';
        return;
      }

      try {
        const ethVal = ethInput ? ethInput.value : '0';
        appendLog('SYS', 'Initiating in-frame DEX swap (' + ethVal + ' ETH ➔ $TTL) via Warpcast wallet...', 'sys', true);

        const txReq = cachedSwapQuote.transactionRequest;
        const fromAddress = (typeof connectedWallet !== 'undefined' && connectedWallet) ? connectedWallet : (txReq.from || undefined);

        const cleanTx = {
          to: txReq.to,
          value: txReq.value,
          data: txReq.data
        };
        if (fromAddress) cleanTx.from = fromAddress;
        if (txReq.gasLimit) cleanTx.gas = txReq.gasLimit;

        const txHash = await provider.request({
          method: 'eth_sendTransaction',
          params: [cleanTx]
        });

        console.log('Swap tx broadcast:', txHash);
        const shortId = (typeof txHash === 'string' && txHash.length > 18) ? (txHash.slice(0, 10) + '...' + txHash.slice(-8)) : String(txHash);
        appendLog('SYS', 'Swap broadcast to Base! Ref: ' + shortId, 'sys', true);
        appendLog('SYS', 'Creator fee routing directly into agent runtime. Lifeline extended.', 'sys', true);

        if (statusBox) {
          statusBox.className = 'swap-status-box success';
          statusBox.innerHTML = '✓ Transaction sent! <br><a href="https://basescan.org/tx/' + txHash + '" target="_blank" style="color:#50e3c2;text-decoration:underline;">View on Basescan ↗</a>';
        }

        executeBtn.textContent = 'SWAP SUBMITTED ✓';

        setTimeout(() => {
          if (typeof checkUserBalance === 'function' && connectedWallet) checkUserBalance(connectedWallet);
          closeFcSwapModal();
        }, 3500);

      } catch (err) {
        console.error('Swap execution error:', err);
        appendLog('SYS', 'Swap cancelled or failed: ' + (err.message || 'User rejected'), 'sys', true);
        if (statusBox) {
          statusBox.className = 'swap-status-box error';
          statusBox.textContent = 'Failed: ' + (err.message || 'Transaction rejected in wallet');
        }
        executeBtn.disabled = false;
        executeBtn.textContent = 'CONFIRM SWAP';
      }
    });
  }
}

if (typeof setupFarcasterSwap === 'function') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupFarcasterSwap);
  } else {
    setupFarcasterSwap();
  }
}
