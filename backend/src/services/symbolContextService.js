'use strict';

/**
 * symbolContextService — pure market context / state computation.
 * No I/O; no side effects.
 *
 * Outputs: marketContext, mode, phaseSequence, strengthScore, contextLines
 */

// ── Context line mapping ──────────────────────────────────────────────────────

const CONTEXT_MAP = {
  buy_pressure  : { mode: 'Покупатели доминируют', lines: ['Объём поддерживает рост цены',    'Покупатели усиливают движение']          },
  sell_pressure : { mode: 'Давление продаж',       lines: ['Объём растёт при падении цены',   'Активные продажи усиливаются']           },
  absorption    : { mode: 'Абсорбция',             lines: ['Объём растёт без движения цены',  'Идёт поглощение объёма']                 },
  weak_move_up  : { mode: 'Слабый рост',           lines: ['Рост без поддержки объёма',       'Движение выглядит слабым']               },
  weak_move_down: { mode: 'Слабое снижение',       lines: ['Падение без объёма',              'Снижение пока не подтверждено объёмом']  },
  cooldown      : { mode: 'Остывание',             lines: ['Активность снижается',            'Рынок затухает']                         },
  choppy_noise  : { mode: 'Шум',                   lines: ['Движение без структуры',          'Явного направления нет']                 },
  neutral       : { mode: 'Нейтрально',            lines: ['Нет доминирующего давления',      'Рынок в равновесии']                     },
};

// ── Market context ────────────────────────────────────────────────────────────

/**
 * Classify the current market state into one of 8 contexts.
 */
function computeMarketContext({ priceState, volumeState, deltaUsdt1m }) {
  const volActive = volumeState === 'spike' || volumeState === 'elevated';
  const volInact  = volumeState === 'inactive';
  const priceUp   = priceState  === 'rising'  || priceState === 'spike_up';
  const priceDown = priceState  === 'falling' || priceState === 'spike_down';
  const priceFlat = priceState  === 'inactive';
  const d         = deltaUsdt1m ?? 0;

  if (volActive && priceUp   && d > 0) return 'buy_pressure';
  if (volActive && priceDown && d < 0) return 'sell_pressure';
  if (volActive && priceFlat)          return 'absorption';
  if (priceUp   && volInact)           return 'weak_move_up';
  if (priceDown && volInact)           return 'weak_move_down';
  if (priceFlat && volInact)           return 'cooldown';
  // mixed pressure signs
  if ((priceUp   && d < 0) || (priceDown && d > 0)) return 'choppy_noise';
  return 'neutral';
}

// ── Phase sequence ────────────────────────────────────────────────────────────

/**
 * Sort available startedAt timestamps and produce a human-readable sequence string.
 * Example: "Объём → Сделки → Цена"
 */
function computePhaseSequence(priceStartedAt, volumeStartedAt, tradesStartedAt) {
  const entries = [];
  if (volumeStartedAt) entries.push({ label: 'Объём',  ts: volumeStartedAt });
  if (tradesStartedAt) entries.push({ label: 'Сделки', ts: tradesStartedAt });
  if (priceStartedAt)  entries.push({ label: 'Цена',   ts: priceStartedAt  });
  if (entries.length < 2) return 'Неопределено';
  entries.sort((a, b) => a.ts - b.ts);
  return entries.map(e => e.label).join(' → ');
}

// ── Strength score ────────────────────────────────────────────────────────────

/**
 * Normalised 0–100 composite score.
 *
 * Formula:
 *   impulse  (0..200 → 0..100) × 0.30
 *   inPlay   (0..200 → 0..100) × 0.30
 *   volRatio (0..3x extra →  0..100) × 0.25
 *   trades   (0..3x extra →  0..100) × 0.15
 */
function computeStrengthScore({ impulseScore, inPlayScore, relativeVolume1m, relativeTrades1m }) {
  const imp  = Math.min(impulseScore    || 0, 200) / 200 * 100;
  const play = Math.min(inPlayScore     || 0, 200) / 200 * 100;
  const vol  = Math.min(Math.max((relativeVolume1m  || 1) - 1, 0), 3) / 3 * 100;
  const trd  = Math.min(Math.max((relativeTrades1m  || 1) - 1, 0), 3) / 3 * 100;
  const raw  = imp * 0.30 + play * 0.30 + vol * 0.25 + trd * 0.15;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {string} params.priceState
 * @param {string} params.volumeState
 * @param {string} params.tradesState
 * @param {number|null} params.deltaUsdt1m
 * @param {number|null} params.impulseScore
 * @param {number|null} params.inPlayScore
 * @param {number|null} params.relativeVolume1m
 * @param {number|null} params.relativeTrades1m
 * @param {number|null} params.priceStartedAt
 * @param {number|null} params.volumeStartedAt
 * @param {number|null} params.tradesStartedAt
 */
function computeContext(params) {
  const marketContext = computeMarketContext(params);
  const mapping       = CONTEXT_MAP[marketContext] || CONTEXT_MAP.neutral;
  const phaseSequence = computePhaseSequence(
    params.priceStartedAt,
    params.volumeStartedAt,
    params.tradesStartedAt,
  );
  const strengthScore = computeStrengthScore(params);

  return {
    marketContext,
    mode          : mapping.mode,
    phaseSequence,
    strengthScore,
    contextLines  : mapping.lines,
  };
}

module.exports = { computeContext };
