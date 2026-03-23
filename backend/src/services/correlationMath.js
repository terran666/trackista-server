'use strict';

/**
 * correlationMath — pure functions for correlation calculation.
 * No I/O. Used by correlationService.
 */

/**
 * Simple returns: r[i] = (close[i] - close[i-1]) / close[i-1]
 */
function computeSimpleReturns(closes) {
  if (!closes || closes.length < 2) return [];
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    returns.push(!prev || prev === 0 ? 0 : (curr - prev) / prev);
  }
  return returns;
}

/**
 * Pearson correlation between two equal-length arrays.
 * Returns null if data is insufficient or constant.
 */
function pearsonCorrelation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;

  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) { sumX += x[i]; sumY += y[i]; }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num  += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  if (den === 0) return null; // constant series
  return num / den;
}

/**
 * Classify a correlation value into state/strength/bias/badge/color.
 */
function classifyCorrelation(r) {
  if (r === null || r === undefined) {
    return {
      correlationState   : 'insufficient_data',
      correlationStrength: null,
      correlationBias    : null,
      badgeText          : 'No data',
      colorHint          : 'gray',
    };
  }

  let correlationState, correlationStrength;
  if      (r >=  0.80) { correlationState = 'very_high_positive'; correlationStrength = 'very_high'; }
  else if (r >=  0.50) { correlationState = 'high_positive';      correlationStrength = 'high';      }
  else if (r >=  0.20) { correlationState = 'mild_positive';      correlationStrength = 'medium';    }
  else if (r >= -0.19) { correlationState = 'neutral';            correlationStrength = 'low';       }
  else if (r >= -0.49) { correlationState = 'mild_negative';      correlationStrength = 'medium';    }
  else if (r >= -0.79) { correlationState = 'high_negative';      correlationStrength = 'high';      }
  else                  { correlationState = 'very_high_negative'; correlationStrength = 'very_high'; }

  let correlationBias, badgeText, colorHint;
  if      (r >=  0.50) { correlationBias = 'follows_btc';        badgeText = 'Follows BTC';   colorHint = 'green';  }
  else if (r >=  0.20) { correlationBias = 'weakly_follows_btc'; badgeText = 'Weak BTC link'; colorHint = 'yellow'; }
  else if (r >= -0.19) { correlationBias = 'decoupled';          badgeText = 'Decoupled';     colorHint = 'gray';   }
  else                  { correlationBias = 'inverse_to_btc';     badgeText = 'Inverse BTC';   colorHint = 'red';    }

  return { correlationState, correlationStrength, correlationBias, badgeText, colorHint };
}

/**
 * Group sorted 1m bars into higher-TF closes.
 * multiplier=1 → return closes as-is
 * multiplier=5 → group into 5-bar chunks, take last close of each chunk
 */
function groupBarsToCloses(bars, multiplier) {
  if (multiplier === 1) {
    return bars.map(b => b.close).filter(v => v != null);
  }
  const result = [];
  const groups = Math.floor(bars.length / multiplier);
  for (let g = 0; g < groups; g++) {
    const slice = bars.slice(g * multiplier, (g + 1) * multiplier);
    const last  = slice[slice.length - 1];
    if (last && last.close != null) result.push(last.close);
  }
  return result;
}

module.exports = { computeSimpleReturns, pearsonCorrelation, classifyCorrelation, groupBarsToCloses };
