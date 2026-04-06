'use strict';

// ──────────────────────────────────────────────────────────────────
// Synthetic Feed Control API
// All endpoints are scoped to SYNTH-* symbols only.
//
// Routes:
//   POST   /api/synth/scenarios            — create/update scenario
//   GET    /api/synth/scenarios/:symbol    — get scenario
//   POST   /api/synth/:symbol/start        — start auto-playback
//   POST   /api/synth/:symbol/pause        — pause
//   POST   /api/synth/:symbol/stop         — stop + clear price keys
//   POST   /api/synth/:symbol/reset        — reset to bar 0
//   POST   /api/synth/:symbol/step         — step one bar forward
//   GET    /api/synth/:symbol/state        — get playback state
// ──────────────────────────────────────────────────────────────────
//
// Expected POST /api/synth/scenarios body:
// {
//   "symbol":              "SYNTH-TEST-1",    // required, must start with "SYNTH-"
//   "basePrice":           100,               // required, positive number
//   "bars": [                                 // required, non-empty array
//     {
//       "open":       100.0,  // required, positive number
//       "high":       101.2,  // required, >= max(open, close)
//       "low":        99.8,   // required, <= min(open, close)
//       "close":      100.9,  // required, positive number
//       "volume":     150000, // optional (>=0), defaults to 0
//       "buyVolume":  90000,  // optional (>=0), defaults to volume/2
//       "sellVolume": 60000,  // optional (>=0), defaults to volume/2
//       "tradeSpeed": 420,    // optional (>=0), defaults to 100
//       "durationMs": 600,    // optional (>0), falls back to defaultBarDurationMs
//       "index":      0       // optional, informational only
//     }
//   ],
//   "defaultBarDurationMs": 600,   // optional, default 600
//   "loop":                false   // optional, default false
// }
//
// Volume contract:
//   buyVolume and sellVolume are INDEPENDENT of volume.
//   volume = total traded volume (can be > buyVolume + sellVolume in real markets).
//   No strict equality is enforced — frontend may provide any of them independently.
// ──────────────────────────────────────────────────────────────────

const { Router } = require('express');

const SYNTH_PREFIX  = 'SYNTH-';
const MAX_BARS      = 10_000;

// ── Symbol validation ────────────────────────────────────────────

function isSynthSymbol(symbol) {
  return typeof symbol === 'string' && symbol.startsWith(SYNTH_PREFIX) && symbol.length > SYNTH_PREFIX.length;
}

function validateSymbolParam(symbol, res) {
  if (!isSynthSymbol(symbol)) {
    res.status(400).json({
      success: false,
      error:   'invalid_symbol',
      message: `symbol must start with "${SYNTH_PREFIX}" and be non-empty after the prefix. Got: ${JSON.stringify(symbol)}`,
    });
    return false;
  }
  return true;
}

// ── Full scenario validation ─────────────────────────────────────
//
// Returns { ok: true, normalized } on success,
// or     { ok: false, error, message } on failure.
//
// Normalization:
//   - basePrice → float
//   - bars: fills defaults for optional fields, keeps raw values otherwise
//   - defaultBarDurationMs → int
//   - loop → boolean

function validateSyntheticScenario(body) {
  const { symbol, basePrice, bars, loop, defaultBarDurationMs } = body || {};

  // symbol
  if (!isSynthSymbol(symbol)) {
    return {
      ok: false,
      error:   'invalid_symbol',
      message: `symbol must start with "${SYNTH_PREFIX}" and not be empty. Got: ${JSON.stringify(symbol)}`,
    };
  }

  // basePrice
  const bp = parseFloat(basePrice);
  if (!isFinite(bp) || bp <= 0) {
    return {
      ok: false,
      error:   'invalid_base_price',
      message: `basePrice must be a finite positive number. Got: ${JSON.stringify(basePrice)}`,
    };
  }

  // bars — top-level
  if (!Array.isArray(bars)) {
    return {
      ok: false,
      error:   'invalid_bars',
      message: `bars must be an array. Got: ${typeof bars}`,
    };
  }
  if (bars.length === 0) {
    return {
      ok: false,
      error:   'invalid_bars',
      message: 'bars must be a non-empty array',
    };
  }
  if (bars.length > MAX_BARS) {
    return {
      ok: false,
      error:   'invalid_bars',
      message: `bars exceeds maximum allowed length (${MAX_BARS}). Got: ${bars.length}`,
    };
  }

  // defaultBarDurationMs
  const defaultDurationMs = defaultBarDurationMs != null
    ? parseInt(defaultBarDurationMs, 10)
    : 600;
  if (!Number.isFinite(defaultDurationMs) || defaultDurationMs <= 0) {
    return {
      ok: false,
      error:   'invalid_default_duration',
      message: `defaultBarDurationMs must be a positive integer. Got: ${JSON.stringify(defaultBarDurationMs)}`,
    };
  }

  // Per-bar validation
  const normalizedBars = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];

    if (b == null || typeof b !== 'object' || Array.isArray(b)) {
      return {
        ok: false,
        error:   'invalid_bar',
        message: `bars[${i}] must be an object. Got: ${JSON.stringify(b)}`,
      };
    }

    const open  = parseFloat(b.open);
    const high  = parseFloat(b.high);
    const low   = parseFloat(b.low);
    const close = parseFloat(b.close);

    if (!isFinite(open)  || open  <= 0) return { ok: false, error: 'invalid_bar', message: `bars[${i}].open must be a positive number. Got: ${JSON.stringify(b.open)}`  };
    if (!isFinite(close) || close <= 0) return { ok: false, error: 'invalid_bar', message: `bars[${i}].close must be a positive number. Got: ${JSON.stringify(b.close)}` };
    if (!isFinite(high)  || high  <= 0) return { ok: false, error: 'invalid_bar', message: `bars[${i}].high must be a positive number. Got: ${JSON.stringify(b.high)}`  };
    if (!isFinite(low)   || low   <= 0) return { ok: false, error: 'invalid_bar', message: `bars[${i}].low must be a positive number. Got: ${JSON.stringify(b.low)}`   };

    // OHLC logic
    if (high < open || high < close) {
      return {
        ok: false,
        error:   'invalid_bar',
        message: `bars[${i}].high (${high}) must be >= open (${open}) and >= close (${close})`,
      };
    }
    if (low > open || low > close) {
      return {
        ok: false,
        error:   'invalid_bar',
        message: `bars[${i}].low (${low}) must be <= open (${open}) and <= close (${close})`,
      };
    }
    if (high < low) {
      return {
        ok: false,
        error:   'invalid_bar',
        message: `bars[${i}].high (${high}) must be >= low (${low})`,
      };
    }

    // Optional numeric fields
    const volume     = b.volume     != null ? parseFloat(b.volume)     : 0;
    const buyVolume  = b.buyVolume  != null ? parseFloat(b.buyVolume)  : null;
    const sellVolume = b.sellVolume != null ? parseFloat(b.sellVolume) : null;
    const tradeSpeed = b.tradeSpeed != null ? parseFloat(b.tradeSpeed) : 100;
    const durationMs = b.durationMs != null ? parseInt(b.durationMs, 10) : defaultDurationMs;

    if (!isFinite(volume) || volume < 0) {
      return { ok: false, error: 'invalid_bar', message: `bars[${i}].volume must be >= 0. Got: ${JSON.stringify(b.volume)}` };
    }
    if (buyVolume != null && (!isFinite(buyVolume) || buyVolume < 0)) {
      return { ok: false, error: 'invalid_bar', message: `bars[${i}].buyVolume must be >= 0. Got: ${JSON.stringify(b.buyVolume)}` };
    }
    if (sellVolume != null && (!isFinite(sellVolume) || sellVolume < 0)) {
      return { ok: false, error: 'invalid_bar', message: `bars[${i}].sellVolume must be >= 0. Got: ${JSON.stringify(b.sellVolume)}` };
    }
    if (!isFinite(tradeSpeed) || tradeSpeed < 0) {
      return { ok: false, error: 'invalid_bar', message: `bars[${i}].tradeSpeed must be >= 0. Got: ${JSON.stringify(b.tradeSpeed)}` };
    }
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return { ok: false, error: 'invalid_bar', message: `bars[${i}].durationMs must be a positive integer. Got: ${JSON.stringify(b.durationMs)}` };
    }

    normalizedBars.push({
      index:       b.index != null ? parseInt(b.index, 10) : i,
      open,
      high,
      low,
      close,
      volume,
      buyVolume:   buyVolume  ?? Math.round(volume / 2),
      sellVolume:  sellVolume ?? Math.round(volume / 2),
      tradeSpeed,
      durationMs,
    });
  }

  return {
    ok: true,
    normalized: {
      symbol,
      basePrice:            bp,
      bars:                 normalizedBars,
      loop:                 Boolean(loop),
      defaultBarDurationMs: defaultDurationMs,
    },
  };
}

// ── Router factory ───────────────────────────────────────────────

function createSynthRouter(synthService) {
  const router = Router();

  // ── POST /api/synth/scenarios ────────────────────────────────────
  router.post('/scenarios', async (req, res) => {
    const body = req.body || {};

    // Pre-validation debug log
    const barsArr    = Array.isArray(body.bars) ? body.bars : [];
    const firstBarKeys = barsArr.length > 0 && barsArr[0] != null
      ? Object.keys(barsArr[0]).join(',')
      : 'n/a';
    console.log(
      `[synth-route] scenario_upload_received symbol=${body.symbol} bars=${barsArr.length}` +
      ` basePrice=${body.basePrice} defaultBarDurationMs=${body.defaultBarDurationMs}` +
      ` loop=${body.loop} firstBarKeys=${firstBarKeys}`,
    );

    const result = validateSyntheticScenario(body);
    if (!result.ok) {
      console.log(`[synth-route] scenario_upload_rejected reason=${result.message}`);
      return res.status(400).json({
        success: false,
        error:   result.error,
        message: result.message,
      });
    }

    try {
      const scenario = await synthService.saveScenario(
        result.normalized.symbol,
        result.normalized,
      );
      const bars = scenario.bars;
      console.log(
        `[synth-route] scenario_upload_saved symbol=${scenario.symbol} bars=${bars.length}` +
        ` firstBar.close=${bars[0]?.close} lastBar.close=${bars[bars.length - 1]?.close}`,
      );
      return res.status(201).json({
        success:    true,
        symbol:     scenario.symbol,
        basePrice:  scenario.basePrice,
        barsCount:  bars.length,
        firstBar:   bars[0]    ?? null,
        lastBar:    bars[bars.length - 1] ?? null,
        loop:       scenario.loop,
        defaultBarDurationMs: scenario.defaultBarDurationMs,
        scenario,
      });
    } catch (err) {
      console.error('[synth-route] saveScenario storage error:', err.message);
      return res.status(500).json({
        success: false,
        error:   'storage_error',
        message: `Failed to save scenario: ${err.message}`,
      });
    }
  });

  // ── GET /api/synth/scenarios/:symbol ────────────────────────────
  router.get('/scenarios/:symbol', async (req, res) => {
    const { symbol } = req.params;
    if (!validateSymbolParam(symbol, res)) return;

    try {
      const scenario = await synthService.getScenario(symbol);
      if (!scenario) {
        return res.status(404).json({ success: false, error: `No scenario found for ${symbol}` });
      }
      return res.json({ success: true, scenario });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── POST /api/synth/:symbol/start ────────────────────────────────
  // Optional body: { speedMs? } (ms per bar)  OR  { speedMultiplier? } (divisor applied to bar.durationMs)
  // Frontend sends speedMs; backend converts to targetDelayMs for the service.
  router.post('/:symbol/start', async (req, res) => {
    const { symbol } = req.params;
    if (!validateSymbolParam(symbol, res)) return;

    try {
      const speedMult = parseFloat(req.body?.speedMultiplier);
      const speedMs   = parseFloat(req.body?.speedMs);
      const opts = {};
      if (isFinite(speedMult) && speedMult > 0) {
        opts.speedMultiplier = speedMult;
      } else if (isFinite(speedMs) && speedMs >= 10 && speedMs <= 60_000) {
        opts.targetDelayMs = speedMs; // service uses this directly as delay per bar
      }
      const state = await synthService.startPlayback(symbol, opts);
      return res.json({ success: true, state });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // ── POST /api/synth/:symbol/pause ────────────────────────────────
  router.post('/:symbol/pause', async (req, res) => {
    const { symbol } = req.params;
    if (!validateSymbolParam(symbol, res)) return;

    try {
      const state = await synthService.pausePlayback(symbol);
      return res.json({ success: true, state });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── POST /api/synth/:symbol/stop ─────────────────────────────────
  // Stops playback and removes price/signal/metrics keys from Redis.
  router.post('/:symbol/stop', async (req, res) => {
    const { symbol } = req.params;
    if (!validateSymbolParam(symbol, res)) return;

    try {
      const state = await synthService.stopPlayback(symbol);
      return res.json({ success: true, state });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── POST /api/synth/:symbol/reset ────────────────────────────────
  // Resets to bar 0 and writes bar[0] price to Redis.
  router.post('/:symbol/reset', async (req, res) => {
    const { symbol } = req.params;
    if (!validateSymbolParam(symbol, res)) return;

    try {
      const state = await synthService.resetPlayback(symbol);
      return res.json({ success: true, state });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── POST /api/synth/:symbol/step ─────────────────────────────────
  // Advances one bar forward (manual step-by-step mode).
  // Stops any running auto-playback timer.
  router.post('/:symbol/step', async (req, res) => {
    const { symbol } = req.params;
    if (!validateSymbolParam(symbol, res)) return;

    try {
      const result = await synthService.stepForward(symbol);
      return res.json({ success: true, ...result });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // ── GET /api/synth/:symbol/state ─────────────────────────────────
  // Returns: { symbol, isRunning, currentBarIndex, totalBars,
  //            status, currentPrice, currentBar, updatedAt }
  router.get('/:symbol/state', async (req, res) => {
    const { symbol } = req.params;
    if (!validateSymbolParam(symbol, res)) return;

    try {
      const fullState = await synthService.getFullState(symbol);
      return res.json({ success: true, ...fullState });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createSynthRouter };
