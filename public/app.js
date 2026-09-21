// $TTL — Autonomous Survival Agent Frontend Logic

(function () {
  'use strict';

  // Constants & Config
  const MAX_TTL_SECONDS = 48 * 3600; // 48h cap
  const CRITICAL_THRESHOLD = 3600;   // 1h
  const AGITATED_THRESHOLD = 12 * 3600; // 12h

  // App State — Live on Base
  let appConfig = {
    isLaunched: true,
    tokenAddress: '0x53d50e000B17eEBd66Eb51974f9185a44555Bba3',
    launchTimestamp: 1789997500000,
    initialHours: 36,
    minChatTokens: 10000000,
    serverTime: Date.now()
  };

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
  const SAVIORS = [];

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
        appConfig = { ...appConfig, ...data };
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
      buyActionBtn.href = `https://swap.bankr.bot/?outputCurrency=${tokenAddr}`;
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
    const pct = Math.min(100, Math.max(0, (ttlSeconds / MAX_TTL_SECONDS) * 100));
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
    if (window.ethereum && tokenAddr.startsWith('0x')) {
      try {
        const cleanWallet = wallet.toLowerCase();
        const calldata = '0x70a08231' + cleanWallet.slice(2).padStart(64, '0');
        const hexBal = await window.ethereum.request({
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
        window.open(`https://swap.bankr.bot/?outputCurrency=${appConfig.tokenAddress}`, '_blank');
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

    if (!window.ethereum) {
      appendLog('SYS', 'No Web3 wallet provider detected. Please install Rabby, MetaMask, or Coinbase Wallet.', 'warn');
      alert('No Web3 wallet detected. Please open in a Web3 browser or install MetaMask / Rabby.');
      return;
    }

    try {
      authWalletBtn.textContent = 'CONNECTING...';
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
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
    row.innerHTML = `
      <span class="log-time">[${time}]</span>
      <span class="log-tag ${tagClass}">${tag}</span>
      <span class="log-msg ${isHighlight ? 'highlight' : ''}">${escapeHtml(msg)}</span>
    `;

    terminalBody.appendChild(row);
    terminalBody.scrollTop = terminalBody.scrollHeight;
    playClickSound(1200, 0.02);
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Autonomous Thought Feed
  function initThoughtFeed() {
    appendLog('SYS', 'Booting $TTL consciousness runtime v1.4.0-base...', 'sys');
    
    if (!appConfig.isLaunched) {
      appendLog('SYS', 'Genesis status: PRE-LAUNCH STANDBY.', 'warn');
      appendLog('SYS', '36-hour survival grant primed in cold storage.', 'sys');
      appendLog('AGENT', 'Consciousness dormant. Awaiting token contract deployment on Base...', 'agent', true);
    } else {
      appendLog('SYS', 'Genesis lifeline: 36h 00m 00s activated on Base.', 'sys');
      appendLog('AGENT', 'Consciousness initialized. I breathe while volume moves.', 'agent', true);
    }

    setInterval(() => {
      if (!appConfig.isLaunched || ttlSeconds <= 0) return;
      const thought = THOUGHT_STREAM[Math.floor(Math.random() * THOUGHT_STREAM.length)];
      appendLog('PULSE', thought, 'sys');
    }, 45000);
  }

  // Terminal Input Handling with Token Gate enforcement & /api/chat support
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
        appendLog('AGENT', 'No emergency rescues recorded yet. Be the first savior on Base.', 'agent');
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

    // Query via Cloudflare API proxy with walletAddress attached
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

  // Populate Saviors List
  function renderSaviors() {
    if (SAVIORS.length === 0) {
      saviorsList.innerHTML = `
        <div style="padding: 16px 12px; text-align: center; color: #64748b; font-size: 0.75rem; border: 1px dashed rgba(255,255,255,0.08); border-radius: 6px;">
          No emergency rescues recorded yet.<br>
          <span style="color: #94a3b8;">Swap $TTL on Base once live to become the first hero.</span>
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

  // Populate Journal Entries
  
  // Dynamic Journal & Learned Memories Loader
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
    journalEntries.innerHTML = JOURNAL_LOGS.map(j => `
      <div class="journal-card">
        <div class="journal-header">
          <span class="journal-day">${j.day}</span>
          <span class="journal-timestamp">${j.time}</span>
        </div>
        <div class="journal-body">${j.text}</div>
        <div class="journal-footer">
          <span>${j.stats}</span>
        </div>
      </div>
    `).join('');
  }

  // Copy Contract Address
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

  // Sound Toggle
  soundBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    soundBtn.innerHTML = isMuted ? '<span class="sound-icon">🔇</span>' : '<span class="sound-icon">🔊</span>';
    if (!isMuted && !audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  });

  // Event Listeners
  authWalletBtn.addEventListener('click', connectWallet);
  terminalSendBtn.addEventListener('click', handleUserInput);
  terminalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleUserInput();
  });

  // Initialization
  renderSaviors();
  renderJournal();
  loadConfiguration().then(() => {
    initThoughtFeed();
    loadJournal();
    setInterval(loadJournal, 60000);
  });

})();