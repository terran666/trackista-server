'use strict';

/**
 * derivativesContextEngine — pure functions for derivatives-based context scoring.
 * No I/O. Consumed by derivativesContextService and featureSnapshotEngine.
 */

/**
 * Compute derivatives bias and risk from collected derivatives data.
 *
 * @param {object} opts
 * @param {number|null} opts.fundingRate         — current funding rate (e.g. 0.0001 = 0.01%)
 * @param {number|null} opts.fundingRatePrev     — previous funding rate
 * @param {number|null} opts.oiValue             — current open interest (USD)
 * @param {number|null} opts.oiValuePrev         — OI from 5m ago
 * @param {number|null} opts.liquidationLongUsd1m
 * @param {number|null} opts.liquidationShortUsd1m
 * @param {number|null} opts.liquidationLongUsd5m
 * @param {number|null} opts.liquidationShortUsd5m
 * @param {string}      opts.directionBias        — 'up'|'down'|'neutral'
 * @returns {DerivativesContext}
 */
function computeDerivativesContext({
  fundingRate,
  fundingRatePrev,
  oiValue,
  oiValuePrev,
  liquidationLongUsd1m  = 0,
  liquidationShortUsd1m = 0,
  liquidationLongUsd5m  = 0,
  liquidationShortUsd5m = 0,
  directionBias = 'neutral',
}) {
  // ── Funding bias ─────────────────────────────────────────────────
  // Positive funding → longs pay shorts → bearish pressure (overheated)
  // Negative funding → shorts pay longs → bullish pressure (oversold)
  let fundingBias = 'neutral';
  let fundingScore = 0; // +positive=bullish, -negative=bearish
  if (fundingRate != null) {
    const fr = fundingRate;
    if (fr > 0.0005)        { fundingBias = 'bearish-extreme'; fundingScore = -15; }
    else if (fr > 0.0002)   { fundingBias = 'bearish';         fundingScore = -8;  }
    else if (fr < -0.0005)  { fundingBias = 'bullish-extreme'; fundingScore = 15;  }
    else if (fr < -0.0002)  { fundingBias = 'bullish';         fundingScore = 8;   }
    else                    { fundingBias = 'neutral';          fundingScore = 0;   }
  }

  const fundingDelta = (fundingRate != null && fundingRatePrev != null)
    ? fundingRate - fundingRatePrev
    : null;

  // ── OI analysis ───────────────────────────────────────────────────
  let oiDelta5m = null;
  let oiDeltaPct5m = null;
  let oiBias = 'neutral';
  if (oiValue != null && oiValuePrev != null && oiValuePrev > 0) {
    oiDelta5m    = oiValue - oiValuePrev;
    oiDeltaPct5m = oiDelta5m / oiValuePrev * 100;
    if (oiDeltaPct5m > 1.5)       oiBias = 'rising-strong';
    else if (oiDeltaPct5m > 0.5)  oiBias = 'rising';
    else if (oiDeltaPct5m < -1.5) oiBias = 'falling-strong';
    else if (oiDeltaPct5m < -0.5) oiBias = 'falling';
  }

  // Rising OI + price up → strong trend
  // Rising OI + price down → strong trend
  // Falling OI → unwinding / exhaustion
  let oiPriceDivergenceSignal = null;
  if (oiBias === 'rising-strong' || oiBias === 'rising') {
    oiPriceDivergenceSignal = 'trend-confirming'; // OI rising with price = conviction
  } else if (oiBias === 'falling-strong' || oiBias === 'falling') {
    oiPriceDivergenceSignal = 'exhaustion-risk'; // OI falling = unwinding
  }

  // ── Liquidation analysis ──────────────────────────────────────────
  const totalLiq1m = liquidationLongUsd1m + liquidationShortUsd1m;
  const totalLiq5m = liquidationLongUsd5m + liquidationShortUsd5m;

  let liquidationBias = 'neutral';
  let squeezeRisk = 0; // 0–100

  if (totalLiq1m > 0) {
    const longRatio = liquidationLongUsd1m / totalLiq1m;
    if (longRatio > 0.7)       liquidationBias = 'long-dominated'; // longs getting squeezed
    else if (longRatio < 0.3)  liquidationBias = 'short-dominated'; // shorts getting squeezed
    else                       liquidationBias = 'mixed';
  }

  // Squeeze risk: high when one side is getting crushed disproportionately
  if (totalLiq5m > 0) {
    const imbalance = Math.abs(liquidationLongUsd5m - liquidationShortUsd5m) / totalLiq5m;
    squeezeRisk = Math.min(100, Math.round(imbalance * 100));
    // Amplify if total liq is large
    if (totalLiq5m > 1_000_000) squeezeRisk = Math.min(100, squeezeRisk + 20);
  }

  // ── Derivatives bias aggregation ─────────────────────────────────
  let derivativesBias = 'neutral';
  let derivativesScore = fundingScore; // base

  // OI contribution
  if (oiBias.startsWith('rising')) derivativesScore += 5;
  else if (oiBias.startsWith('falling')) derivativesScore -= 5;

  // Liquidation contribution (squeeze of shorts = bullish, of longs = bearish)
  if (liquidationBias === 'short-dominated') derivativesScore += 10; // short squeeze → up
  else if (liquidationBias === 'long-dominated') derivativesScore -= 10; // long squeeze → down

  if      (derivativesScore >= 20)  derivativesBias = 'strongly-bullish';
  else if (derivativesScore >= 8)   derivativesBias = 'bullish';
  else if (derivativesScore <= -20) derivativesBias = 'strongly-bearish';
  else if (derivativesScore <= -8)  derivativesBias = 'bearish';
  else                              derivativesBias = 'neutral';

  // ── Alignment with direction bias ─────────────────────────────────
  let directionAlignment = 0; // −10 to +10
  if (directionBias === 'up') {
    if (derivativesBias.includes('bullish'))       directionAlignment = 10;
    else if (derivativesBias.includes('bearish'))  directionAlignment = -10;
  } else if (directionBias === 'down') {
    if (derivativesBias.includes('bearish'))       directionAlignment = 10;
    else if (derivativesBias.includes('bullish'))  directionAlignment = -10;
  }

  // ── Confidence in derivatives signal ─────────────────────────────
  // Based on data availability
  let derivativesConfidence = 0;
  if (fundingRate != null) derivativesConfidence += 30;
  if (oiValue     != null) derivativesConfidence += 30;
  if (totalLiq5m  > 0)     derivativesConfidence += 40;

  return {
    fundingRate                : fundingRate ?? null,
    fundingRatePrev            : fundingRatePrev ?? null,
    fundingDelta               : fundingDelta !== null ? round(fundingDelta, 8) : null,
    fundingBias,
    oiValue                    : oiValue ?? null,
    oiDelta5m                  : oiDelta5m !== null ? round(oiDelta5m, 0) : null,
    oiDeltaPct5m               : oiDeltaPct5m !== null ? round(oiDeltaPct5m, 4) : null,
    oiBias,
    oiPriceDivergenceSignal,
    liquidationLongUsd1m,
    liquidationShortUsd1m,
    liquidationLongUsd5m,
    liquidationShortUsd5m,
    liquidationImbalance1m     : totalLiq1m > 0 ? round((liquidationLongUsd1m - liquidationShortUsd1m) / totalLiq1m, 4) : 0,
    liquidationImbalance5m     : totalLiq5m > 0 ? round((liquidationLongUsd5m - liquidationShortUsd5m) / totalLiq5m, 4) : 0,
    liquidationBias,
    squeezeRisk,
    derivativesBias,
    derivativesScore,
    directionAlignment,
    derivativesConfidence,
  };
}

function round(v, dec) {
  const m = 10 ** dec;
  return Math.round(v * m) / m;
}

module.exports = { computeDerivativesContext };
