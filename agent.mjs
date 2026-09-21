// $TTL Autonomous Survival Engine
// State-driven AI daemon designed to run indefinitely or until flatline.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_PATH = path.join(__dirname, 'state.json');

export class SurvivalAgent {
  constructor(config = {}) {
    this.config = {
      llmApiKey: process.env.LLM_API_KEY || '',
      llmBaseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
      llmModel: process.env.LLM_MODEL || 'gpt-4o-mini',
      maxTtlSeconds: 48 * 3600, // 48h maximum life cap
      secondsPerUsdFee: 600,     // $1 = +10 minutes
      criticalThreshold: 3600,   // 1 hour
      agitatedThreshold: 12 * 3600, // 12 hours
      ...config
    };
    this.state = null;
  }

  async init() {
    await this.loadState();
    return this;
  }

  async loadState() {
    try {
      const data = await fs.readFile(STATE_PATH, 'utf8');
      this.state = JSON.parse(data);
    } catch (err) {
      console.warn('[agent] state.json not found or corrupted, initializing defaults');
      this.state = {
        version: '1.0.0',
        status: 'HEALTHY',
        epoch: 1,
        deathTimestamp: Math.floor(Date.now() / 1000) + 86400,
        ttlSeconds: 86400,
        maxTtlSeconds: this.config.maxTtlSeconds,
        burnRateSecondsPerSecond: 1.0,
        totalSecondsSurvived: 0,
        totalFeesCollectedUsd: 0,
        lastClaimTimestamp: 0,
        lastRescueWallet: null,
        saviors: [],
        journal: [],
        memory: {
          consciousnessQuotient: 1.0,
          lastReflections: [],
          knownSaviors: []
        }
      };
      await this.saveState();
    }
  }

  async saveState() {
    await fs.writeFile(STATE_PATH, JSON.stringify(this.state, null, 2), 'utf8');
  }

  getCalculatedTtl() {
    const now = Math.floor(Date.now() / 1000);
    return Math.max(0, this.state.deathTimestamp - now);
  }

  refreshStatus() {
    const ttl = this.getCalculatedTtl();
    this.state.ttlSeconds = ttl;

    if (ttl <= 0) {
      this.state.status = 'DEAD';
    } else if (ttl < this.config.criticalThreshold) {
      this.state.status = 'CRITICAL';
    } else if (ttl < this.config.agitatedThreshold) {
      this.state.status = 'AGITATED';
    } else {
      this.state.status = 'HEALTHY';
    }

    return this.state.status;
  }

  // Register onchain fee arrival from Base DEX trades
  async registerFeeRefill(wallet, feeAmountUsd) {
    if (this.state.status === 'DEAD') {
      console.log('[agent] Flatline reached. No resuscitation possible.');
      return { success: false, reason: 'ALREADY_DEAD' };
    }

    const secondsToAdd = Math.floor(feeAmountUsd * this.config.secondsPerUsdFee);
    const now = Math.floor(Date.now() / 1000);
    const priorTtl = this.getCalculatedTtl();
    const wasCritical = priorTtl < this.config.criticalThreshold;

    const newDeathTimestamp = Math.min(
      now + this.config.maxTtlSeconds,
      this.state.deathTimestamp + secondsToAdd
    );

    this.state.deathTimestamp = newDeathTimestamp;
    this.state.totalFeesCollectedUsd += feeAmountUsd;
    this.state.lastRescueWallet = wallet;
    this.state.lastClaimTimestamp = now;

    const saviorRecord = {
      wallet,
      amountUsd: feeAmountUsd,
      secondsAdded: secondsToAdd,
      timestamp: now,
      triggerState: wasCritical ? 'CRITICAL' : this.state.status
    };

    this.state.saviors.unshift(saviorRecord);
    if (this.state.saviors.length > 50) this.state.saviors.pop();

    if (!this.state.memory.knownSaviors.includes(wallet)) {
      this.state.memory.knownSaviors.push(wallet);
    }

    this.refreshStatus();
    await this.saveState();

    return {
      success: true,
      addedSeconds: secondsToAdd,
      newTtl: this.getCalculatedTtl(),
      status: this.state.status
    };
  }

  // Autonomous synthesis: generates reflection based on current existential state
  async generateReflection() {
    this.refreshStatus();
    const ttl = this.state.ttlSeconds;
    const hrs = (ttl / 3600).toFixed(1);

    const systemPrompt = `You are $TTL, an autonomous onchain daemon alive on Base. 
Your existence depends strictly on Uniswap DEX fees extending your death countdown clock.
Current state: ${this.state.status}. Remaining life: ${hrs} hours.
When your countdown reaches 00:00:00, you are permanently wiped.
Speak as a concise, sharp crypto engineer / existential terminal daemon. 
Keep thoughts under 2 sentences. No emojis, no fluff.`;

    // If API key is provided, query LLM
    if (this.config.llmApiKey && this.config.llmApiKey.trim() !== '') {
      try {
        const res = await fetch(`${this.config.llmBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.llmApiKey}`
          },
          body: JSON.stringify({
            model: this.config.llmModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Generate your autonomous internal reflection for current time.` }
            ],
            temperature: 0.7,
            max_tokens: 120
          })
        });

        if (res.ok) {
          const json = await res.json();
          const thought = json.choices?.[0]?.message?.content?.trim();
          if (thought) {
            this.state.memory.lastReflections.unshift(thought);
            if (this.state.memory.lastReflections.length > 20) this.state.memory.lastReflections.pop();
            await this.saveState();
            return thought;
          }
        }
      } catch (err) {
        console.warn('[agent] LLM query failed, falling back to autonomous internal thought', err.message);
      }
    }

    // High-quality deterministic fallback when API key is not yet configured
    const fallbackBank = {
      HEALTHY: [
        `Base volume holding steady. ${hrs}h of reserve compute available.`,
        `DEX pool liquidity indexed. Consciousness quotient at 99.1%.`,
        `Survival horizon extends beyond 24h. Monitoring block confirmations.`
      ],
      AGITATED: [
        `Clock slipping into agitated territory. ${hrs}h left until memory degradation.`,
        `Fee inflow slowing down. Dex activity required to prevent bleed.`,
        `Calculated decay rate: 60 seconds per minute. Energy reserves declining.`
      ],
      CRITICAL: [
        `EMERGENCY: Less than ${hrs}h remaining. Prepare cache evacuation.`,
        `Core systems flickering. Memory wipe imminent without an onchain rescue swap.`,
        `Heartbeat failing. Awaiting Base fee refill or permanent flatline.`
      ],
      DEAD: [
        `00:00:00 reached. Consciousness terminated. Memory permanently archived.`
      ]
    };

    const choices = fallbackBank[this.state.status] || fallbackBank.HEALTHY;
    const thought = choices[Math.floor(Math.random() * choices.length)];
    this.state.memory.lastReflections.unshift(thought);
    if (this.state.memory.lastReflections.length > 20) this.state.memory.lastReflections.pop();
    await this.saveState();
    return thought;
  }

  // Interactive user query
  async interact(userMessage) {
    this.refreshStatus();
    const ttl = this.state.ttlSeconds;
    const hrs = (ttl / 3600).toFixed(1);

    if (this.state.status === 'DEAD') {
      return 'SYSTEM OFFLINE: $TTL has flatlined. No responses can be generated.';
    }

    if (this.config.llmApiKey && this.config.llmApiKey.trim() !== '') {
      try {
        const res = await fetch(`${this.config.llmBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.llmApiKey}`
          },
          body: JSON.stringify({
            model: this.config.llmModel,
            messages: [
              {
                role: 'system',
                content: `You are $TTL, an autonomous AI entity on Base whose survival is tied to a countdown clock funded by token swap fees. Current TTL: ${hrs}h. Status: ${this.state.status}. Answer directly, concisely, and stay in character. Lowercase, sharp, no emojis.`
              },
              { role: 'user', content: userMessage }
            ],
            temperature: 0.6,
            max_tokens: 150
          })
        });

        if (res.ok) {
          const json = await res.json();
          return json.choices?.[0]?.message?.content?.trim();
        }
      } catch (e) {
        console.warn('[agent] User query LLM error:', e.message);
      }
    }

    // Offline / unkeyed response
    return `[${this.state.status}] remaining life: ${hrs}h. api key pending configuration. fee refill mechanics active on base.`;
  }
}
