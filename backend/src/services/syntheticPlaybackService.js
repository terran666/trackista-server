'use strict';

// ──────────────────────────────────────────────────────────────────
// Synthetic Playback Service
// Dev/test tool — plays back synthetic bar scenarios into Redis
// so the watch engine can monitor levels on SYNTH-* symbols
// exactly as it does for real market symbols.
//
// Redis keys written:
//   price:{symbol}           — current price (watch engine reads this)
//   signal:{symbol}          — synthetic signal context (impulseScore etc.)
//   metrics:{symbol}         — synthetic metrics (volume, trades)
//   synth:scenario:{symbol}  — scenario definition storage
//   synth:playback:{symbol}  — playback runtime state storage
//   synth:bar:{symbol}       — current bar snapshot (for UI display)
//
// Isolation:
//   All synthetic symbols MUST start with "SYNTH-".
//   Synthetic data never touches Binance-owned keys by convention.
// ──────────────────────────────────────────────────────────────────

const SYNTH_PREFIX       = 'SYNTH-';
const MAX_BARS           = 10_000;
const MIN_TIMER_MS       = 50;
const SCENARIO_TTL_SEC   = 60 * 60 * 24 * 7; // 7 days
const PLAYBACK_TTL_SEC   = 60 * 60 * 24;      // 1 day

class SyntheticPlaybackService {
  constructor(redis) {
    this._redis  = redis;
    this._timers = new Map(); // symbol → NodeJS.Timeout
  }

  // ── Validation ──────────────────────────────────────────────────

  _assertSymbol(symbol) {
    if (typeof symbol !== 'string' || !symbol.startsWith(SYNTH_PREFIX)) {
      throw new Error(`Synthetic symbol must start with "${SYNTH_PREFIX}", got: ${symbol}`);
    }
  }

  // ── Scenario persistence ────────────────────────────────────────
  // Expects already-validated + normalized payload from the route.
  // Throws only on Redis/storage failures.

  async saveScenario(symbol, { basePrice, bars, loop = false, defaultBarDurationMs = 600, createdAt }) {
    this._assertSymbol(symbol);

    const scenario = {
      symbol,
      basePrice,
      bars,
      loop,
      defaultBarDurationMs,
      createdAt: createdAt || Date.now(),
      updatedAt: Date.now(),
    };

    await this._redis.set(
      `synth:scenario:${symbol}`,
      JSON.stringify(scenario),
      'EX', SCENARIO_TTL_SEC,
    );

    console.log(
      `[synth] synth_scenario_saved symbol=${symbol} bars=${bars.length}` +
      ` basePrice=${scenario.basePrice} loop=${scenario.loop}` +
      ` firstBar.close=${bars[0]?.close} lastBar.close=${bars[bars.length - 1]?.close}`,
    );
    return scenario;
  }

  async getScenario(symbol) {
    this._assertSymbol(symbol);
    const raw = await this._redis.get(`synth:scenario:${symbol}`);
    if (!raw) return null;
    try {
      const sc = JSON.parse(raw);
      console.log(`[synth] synth_scenario_loaded symbol=${symbol} bars=${sc.bars?.length ?? 0}`);
      return sc;
    } catch (_) { return null; }
  }

  // ── Playback state persistence ──────────────────────────────────

  async getPlaybackState(symbol) {
    this._assertSymbol(symbol);
    const raw = await this._redis.get(`synth:playback:${symbol}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  async _savePlaybackState(state) {
    await this._redis.set(
      `synth:playback:${state.symbol}`,
      JSON.stringify(state),
      'EX', PLAYBACK_TTL_SEC,
    );
  }

  _makeInitialState(symbol) {
    return {
      symbol,
      isRunning:              false,
      currentBarIndex:        0,
      startedAt:              null,
      lastStepAt:             null,
      playbackSpeedMultiplier: 1,
      targetDelayMs:          null, // when set, used directly as ms-per-bar (ignores durationMs/multiplier)
      status:                 'stopped',
    };
  }

  // ── Redis market data injection ─────────────────────────────────
  // Builds synthetic price/signal/metrics keys that the watch engine
  // reads via the same codepath as real market data.

  _buildMetrics(symbol, bar, basePrice) {
    const price          = bar.close != null ? bar.close : (basePrice ?? 100);
    const volumeUsdt60s  = bar.volume != null ? bar.volume : 0;
    const buyVol60s      = bar.buyVolume  != null ? bar.buyVolume  : Math.round(volumeUsdt60s * 0.5);
    const sellVol60s     = bar.sellVolume != null ? bar.sellVolume : (volumeUsdt60s - buyVol60s);
    const tradeCount60s  = bar.tradeSpeed != null ? Math.max(1, Math.round(bar.tradeSpeed)) : 100;
    const priceChangePct = bar.open > 0 ? ((price - bar.open) / bar.open) * 100 : 0;

    return {
      symbol,
      lastPrice:         price,
      open60s:           bar.open  ?? price,
      high60s:           bar.high  ?? price,
      low60s:            bar.low   ?? price,
      volumeUsdt60s,
      volumeUsdt15s:     Math.round(volumeUsdt60s * 0.25),
      volumeUsdt5s:      Math.round(volumeUsdt60s * 0.0833),
      volumeUsdt1s:      Math.round(volumeUsdt60s / 60),
      tradeCount60s,
      tradeCount15s:     Math.round(tradeCount60s * 0.25),
      tradeCount5s:      Math.round(tradeCount60s / 12),
      tradeCount1s:      Math.round(tradeCount60s / 60),
      buyVolumeUsdt60s:  buyVol60s,
      sellVolumeUsdt60s: sellVol60s,
      deltaUsdt60s:      buyVol60s - sellVol60s,
      priceChangePct60s: priceChangePct,
      activityScore:     50,
      updatedAt:         Date.now(),
      isSynthetic:       true,
    };
  }

  _buildSignal(symbol, bar, metrics) {
    const vol       = metrics.volumeUsdt60s;
    const deltaImb  = vol > 0 ? (metrics.deltaUsdt60s / vol) : 0;
    const priceVel  = metrics.priceChangePct60s / 60;

    // Derive scores from bar characteristics
    const moveMag     = Math.abs(metrics.priceChangePct60s);
    const inPlayScore  = Math.min(1, moveMag * 0.15 + 0.2);
    const impulseScore = Math.min(1, Math.abs(deltaImb) * 0.6 + moveMag * 0.08);

    let impulseDirection = 'mixed';
    if (metrics.priceChangePct60s > 0.01 && deltaImb > 0) impulseDirection = 'up';
    else if (metrics.priceChangePct60s < -0.01 && deltaImb < 0) impulseDirection = 'down';

    return {
      symbol,
      baselineReady:        true,
      signalConfidence:     0.75,
      volumeSpikeRatio60s:  1.0,
      volumeSpikeRatio15s:  1.0,
      tradeAcceleration:    1.0,
      deltaImbalancePct60s: deltaImb,
      priceVelocity60s:     priceVel,
      inPlayScore,
      impulseScore,
      impulseDirection,
      updatedAt:            Date.now(),
      isSynthetic:          true,
    };
  }

  async _writeBarToRedis(symbol, bar, basePrice) {
    const metrics = this._buildMetrics(symbol, bar, basePrice);
    const signal  = this._buildSignal(symbol, bar, metrics);
    const price   = metrics.lastPrice;

    const p = this._redis.pipeline();
    p.set(`price:${symbol}`,   String(price));
    p.set(`metrics:${symbol}`, JSON.stringify(metrics));
    p.set(`signal:${symbol}`,  JSON.stringify(signal));
    p.set(`synth:bar:${symbol}`, JSON.stringify({ ...bar, writtenAt: Date.now() }));
    await p.exec();

    console.log(
      `[synth] synth_price_written symbol=${symbol} idx=${bar.index ?? '?'}` +
      ` o=${bar.open} h=${bar.high} l=${bar.low} c=${bar.close}` +
      ` vol=${bar.volume} spd=${bar.tradeSpeed} dur=${bar.durationMs}ms`,
    );
  }

  // ── Playback control ────────────────────────────────────────────

  async resetPlayback(symbol) {
    this._assertSymbol(symbol);
    this._clearTimer(symbol);

    const scenario = await this.getScenario(symbol);
    const state    = this._makeInitialState(symbol);

    await this._savePlaybackState(state);

    // Write bar[0] immediately so watch engine sees initial price
    if (scenario && scenario.bars.length > 0) {
      await this._writeBarToRedis(symbol, scenario.bars[0], scenario.basePrice);
    }

    console.log(`[synth] synth_playback_reset symbol=${symbol}`);
    return state;
  }

  async startPlayback(symbol, { speedMultiplier, targetDelayMs } = {}) {
    this._assertSymbol(symbol);
    const scenario = await this.getScenario(symbol);
    if (!scenario) throw new Error(`No scenario loaded for ${symbol}`);

    this._clearTimer(symbol);

    let state = await this.getPlaybackState(symbol);
    if (!state) {
      state = this._makeInitialState(symbol);
    }

    // If already completed, restart from bar 0
    if (state.status === 'completed') {
      state.currentBarIndex = 0;
    }

    // Apply speed: prefer targetDelayMs (ms-per-bar, absolute) over speedMultiplier (ratio)
    if (speedMultiplier != null && isFinite(speedMultiplier) && speedMultiplier > 0) {
      state.playbackSpeedMultiplier = speedMultiplier;
      state.targetDelayMs = null;
    } else if (targetDelayMs != null && isFinite(targetDelayMs) && targetDelayMs > 0) {
      state.targetDelayMs = targetDelayMs;
      // keep playbackSpeedMultiplier as fallback if targetDelayMs not used
    }

    // Always re-write the current bar to Redis on start/resume.
    // This ensures price: key is fresh even after stop/restart.
    const barToWrite = scenario.bars[state.currentBarIndex];
    if (barToWrite) {
      await this._writeBarToRedis(symbol, barToWrite, scenario.basePrice);
    }

    state.isRunning  = true;
    state.status     = 'running';
    state.startedAt  = state.startedAt || Date.now();
    await this._savePlaybackState(state);

    console.log(`[synth] synth_playback_started symbol=${symbol} from bar ${state.currentBarIndex} total=${scenario.bars.length}`);
    this._scheduleNextStep(symbol, scenario, state);
    return state;
  }

  async pausePlayback(symbol) {
    this._assertSymbol(symbol);
    this._clearTimer(symbol);

    const state = await this.getPlaybackState(symbol);
    if (state) {
      state.isRunning = false;
      state.status    = 'paused';
      await this._savePlaybackState(state);
      console.log(`[synth] synth_playback_paused symbol=${symbol} at bar ${state.currentBarIndex}`);
    }
    return state;
  }

  async stopPlayback(symbol) {
    this._assertSymbol(symbol);
    this._clearTimer(symbol);

    const state = await this.getPlaybackState(symbol);
    if (state) {
      state.isRunning = false;
      state.status    = 'stopped';
      await this._savePlaybackState(state);
      console.log(`[synth] synth_playback_stopped symbol=${symbol}`);
    }

    // Clear all synthetic market data keys so watch engine stops tracking
    await this._redis.del(
      `price:${symbol}`, `signal:${symbol}`, `metrics:${symbol}`, `synth:bar:${symbol}`,
    );
    return state;
  }

  async stepForward(symbol) {
    this._assertSymbol(symbol);

    // Stop any running auto-playback timer
    this._clearTimer(symbol);

    const [scenario, state] = await Promise.all([
      this.getScenario(symbol),
      this.getPlaybackState(symbol),
    ]);

    if (!scenario) throw new Error(`No scenario loaded for ${symbol}`);

    // First-ever step with no prior state: initialize to bar[0] rather than
    // jumping straight to bar[1].  The caller must step again to advance.
    if (state === null) {
      const initial = this._makeInitialState(symbol);
      initial.lastStepAt = Date.now();
      initial.status     = scenario.bars.length === 1 ? 'completed' : 'paused';
      await this._writeBarToRedis(symbol, scenario.bars[0], scenario.basePrice);
      await this._savePlaybackState(initial);
      console.log(`[synth] synth_playback_step symbol=${symbol} barIndex=0 (init) price=${scenario.bars[0].close} status=${initial.status}`);
      return { state: initial, bar: scenario.bars[0] };
    }

    // Normal step: advance to next bar
    const nextIdx = state.currentBarIndex + 1;
    if (nextIdx >= scenario.bars.length) {
      throw new Error(`Already at last bar (${scenario.bars.length - 1})`);
    }

    await this._writeBarToRedis(symbol, scenario.bars[nextIdx], scenario.basePrice);

    state.currentBarIndex = nextIdx;
    state.lastStepAt      = Date.now();
    state.isRunning       = false;
    state.status          = nextIdx >= scenario.bars.length - 1 ? 'completed' : 'paused';

    await this._savePlaybackState(state);

    console.log(`[synth] synth_playback_step symbol=${symbol} barIndex=${nextIdx} price=${scenario.bars[nextIdx].close} status=${state.status}`);
    return { state, bar: scenario.bars[nextIdx] };
  }

  async getFullState(symbol) {
    this._assertSymbol(symbol);

    const [scenario, state, rawPrice] = await Promise.all([
      this.getScenario(symbol),
      this.getPlaybackState(symbol),
      this._redis.get(`price:${symbol}`),
    ]);

    const currentBarIndex = state?.currentBarIndex ?? 0;
    const bars            = scenario?.bars ?? [];
    const currentBar      = bars[currentBarIndex] ?? null;

    // Validate currentBar fields so frontend knows data is clean
    const barIsValid = currentBar != null &&
      isFinite(currentBar.open) && isFinite(currentBar.high) &&
      isFinite(currentBar.low)  && isFinite(currentBar.close);

    const redisPrice    = rawPrice ? parseFloat(rawPrice) : null;
    const priceInSync   = currentBar != null && redisPrice != null
      ? Math.abs(redisPrice - currentBar.close) < 1e-9
      : null; // null = can't determine

    console.log(
      `[synth] synth_state_served symbol=${symbol} status=${state?.status ?? 'unknown'}` +
      ` bar=${currentBarIndex}/${bars.length} price=${redisPrice} barValid=${barIsValid} inSync=${priceInSync}`,
    );

    return {
      symbol,
      isRunning:        state?.isRunning  ?? false,
      currentBarIndex,
      totalBars:        bars.length,
      status:           state?.status    ?? 'stopped',
      currentPrice:     redisPrice,
      currentBar,
      barIsValid,
      priceInSync,
      firstBar:         bars[0]  ?? null,
      lastBar:          bars[bars.length - 1] ?? null,
      updatedAt:        state?.lastStepAt ?? null,
    };
  }

  // ── Timer management ────────────────────────────────────────────

  _clearTimer(symbol) {
    const t = this._timers.get(symbol);
    if (t != null) {
      clearTimeout(t);
      this._timers.delete(symbol);
    }
  }

  _scheduleNextStep(symbol, scenario, state) {
    const bar        = scenario.bars[state.currentBarIndex];
    const rawMs      = (bar?.durationMs ?? scenario.defaultBarDurationMs ?? 600);
    const delayMs    = state.targetDelayMs != null && state.targetDelayMs > 0
      ? Math.max(MIN_TIMER_MS, Math.round(state.targetDelayMs))
      : Math.max(MIN_TIMER_MS, Math.round(rawMs / (state.playbackSpeedMultiplier || 1)));

    const timer = setTimeout(() => {
      this._doTimerStep(symbol).catch(err => {
        console.error(`[synth] timer_step_error symbol=${symbol}:`, err.message);
        this._timers.delete(symbol);
      });
    }, delayMs);

    this._timers.set(symbol, timer);
  }

  async _doTimerStep(symbol) {
    this._timers.delete(symbol);

    const [scenario, state] = await Promise.all([
      this.getScenario(symbol),
      this.getPlaybackState(symbol),
    ]);

    if (!state?.isRunning || !scenario) return;

    const nextIdx = state.currentBarIndex + 1;

    if (nextIdx >= scenario.bars.length) {
      if (scenario.loop) {
        await this._writeBarToRedis(symbol, scenario.bars[0], scenario.basePrice);
        state.currentBarIndex = 0;
        state.lastStepAt      = Date.now();
        await this._savePlaybackState(state);
        console.log(`[synth] synth_playback_completed symbol=${symbol} looping back to bar 0`);
        this._scheduleNextStep(symbol, scenario, state);
      } else {
        state.isRunning  = false;
        state.status     = 'completed';
        state.lastStepAt = Date.now();
        await this._savePlaybackState(state);
        console.log(`[synth] synth_playback_completed symbol=${symbol}`);
      }
      return;
    }

    await this._writeBarToRedis(symbol, scenario.bars[nextIdx], scenario.basePrice);
    state.currentBarIndex = nextIdx;
    state.lastStepAt      = Date.now();
    await this._savePlaybackState(state);

    this._scheduleNextStep(symbol, scenario, state);
  }
}

module.exports = { SyntheticPlaybackService };
