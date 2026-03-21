'use strict';
/**
 * runtimeQaEngine.js — Phase 2 Runtime QA
 *
 * Pure functions for validating runtime state of Phase 2 services and data.
 * No I/O — all inputs come from the callers.
 */

// ─── Freshness thresholds (env-overridable) ───────────────────────
const MAX_SERVICE_STALE_MS    = parseInt(process.env.RUNTIME_QA_MAX_SERVICE_STALE_MS      || '60000',  10);
const MAX_PRESIGNAL_STALE_MS  = parseInt(process.env.RUNTIME_QA_MAX_PRESIGNAL_STALE_MS    || '20000',  10);
const MAX_MOVE_STALE_MS       = parseInt(process.env.RUNTIME_QA_MAX_MOVE_STALE_MS         || '15000',  10);
const MAX_DERIVATIVES_STALE_MS= parseInt(process.env.RUNTIME_QA_MAX_DERIVATIVES_STALE_MS  || '120000', 10);
const MAX_PAYLOAD_STALE_MS    = parseInt(process.env.RUNTIME_QA_MAX_TESTTEST_PAYLOAD_STALE_MS || '30000', 10);

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────
function safe(v)  { return typeof v === 'number' && isFinite(v) ? v : null; }
function now()    { return Date.now(); }
function ageMs(ts){ return ts ? (now() - ts) : null; }

// ─────────────────────────────────────────────────────────────────────────────
// 4.1  validateServiceState(serviceState)
// ─────────────────────────────────────────────────────────────────────────────
function validateServiceState(state) {
  const problems     = [];
  const metricsSummary = {};

  if (!state || typeof state !== 'object') {
    return { status: 'fail', stale: true, problems: ['service state missing or invalid'], metricsSummary };
  }

  if (!state.serviceName)  problems.push('missing serviceName');
  if (!state.startedAt)    problems.push('missing startedAt');

  const age = ageMs(state.lastRunTs);
  const stale = age === null || age > MAX_SERVICE_STALE_MS;
  if (age === null)  problems.push('lastRunTs not set');
  else if (stale)    problems.push(`lastRunTs stale ${age}ms (limit ${MAX_SERVICE_STALE_MS}ms)`);

  metricsSummary.lastRunAgeMs     = age;
  metricsSummary.runCount         = state.runCount         ?? null;
  metricsSummary.symbolsProcessed = state.symbolsProcessed ?? null;
  metricsSummary.avgLoopMs        = state.avgLoopMs        ?? null;
  metricsSummary.maxLoopMs        = state.maxLoopMs        ?? null;
  metricsSummary.errorsCount      = state.errorsCount      ?? 0;

  if ((state.errorsCount ?? 0) > 50) problems.push(`high error count: ${state.errorsCount}`);
  if ((state.symbolsProcessed ?? 0) === 0 && state.runCount > 2)
    problems.push('symbolsProcessed=0 after multiple runs');

  const status = problems.length === 0 ? 'ok' : stale ? 'fail' : 'warning';
  return { status, stale, problems, metricsSummary };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.2  validateRedisPayload(keyName, payload, rules)
//
// rules = {
//   requiredFields?: string[],
//   numericFields?:  string[],
//   tsField?:        string,       // field holding the ts to check age
//   maxAgeMs?:       number,
//   arraysNonEmpty?: string[],
// }
// ─────────────────────────────────────────────────────────────────────────────
function validateRedisPayload(keyName, payload, rules = {}) {
  const missingFields  = [];
  const invalidFields  = [];
  const notes          = [];

  if (payload === null || payload === undefined) {
    return {
      keyName,
      status       : 'fail',
      missingFields: rules.requiredFields || [],
      invalidFields: [],
      stale        : true,
      ageMs        : null,
      notes        : ['key missing or empty'],
    };
  }

  if (typeof payload === 'string') {
    return {
      keyName,
      status       : 'fail',
      missingFields: [],
      invalidFields: ['root (not JSON)'],
      stale        : true,
      ageMs        : null,
      notes        : ['payload is raw string, not parsed object'],
    };
  }

  // Required fields
  for (const f of (rules.requiredFields || [])) {
    if (payload[f] === undefined || payload[f] === null) missingFields.push(f);
  }

  // Numeric fields should be finite numbers
  for (const f of (rules.numericFields || [])) {
    const v = payload[f];
    if (v !== undefined && v !== null && (typeof v !== 'number' || !isFinite(v)))
      invalidFields.push(`${f} (non-finite: ${v})`);
  }

  // Arrays non-empty
  for (const f of (rules.arraysNonEmpty || [])) {
    if (!Array.isArray(payload[f]) || payload[f].length === 0)
      notes.push(`${f} is empty array or missing`);
  }

  // Freshness
  const tsField  = rules.tsField || 'ts';
  const tsVal    = payload[tsField];
  const age      = ageMs(typeof tsVal === 'string' ? new Date(tsVal).getTime() : tsVal);
  const maxAge   = rules.maxAgeMs ?? MAX_PAYLOAD_STALE_MS;
  const stale    = age === null || age > maxAge;
  if (age === null) notes.push('no ts field found');
  else if (stale)   notes.push(`stale ${age}ms (limit ${maxAge}ms)`);

  const status = missingFields.length > 0 ? 'fail'
    : (stale || invalidFields.length > 0) ? 'warning' : 'ok';

  return { keyName, status, missingFields, invalidFields, stale, ageMs: age, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.3  validateTesttestSymbolPayload(payload)
// ─────────────────────────────────────────────────────────────────────────────
function validateTesttestSymbolPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      status: 'fail',
      sections: {},
      problems: ['payload is null or not an object'],
      completenessScore: 0,
    };
  }

  const { layers = {}, ranking, explain } = payload;
  const problems = [];
  const sections = {};

  // ── price ──────────────────────────────────────────────────────
  const priceVal = layers.price ?? payload.price;
  const priceParsed = typeof priceVal === 'object' ? priceVal : null;
  const rawPrice = priceParsed?.currentPrice ?? (typeof priceVal === 'string' ? parseFloat(priceVal) : null);
  sections.price = rawPrice > 0
    ? { status: 'ok' } : { status: 'fail', error: 'price missing or invalid' };
  if (sections.price.status !== 'ok') problems.push('price missing');

  // ── metrics ────────────────────────────────────────────────────
  const metrics = layers.metrics;
  sections.metrics = metrics && typeof metrics === 'object'
    ? { status: 'ok' } : { status: 'fail', error: 'metrics block missing' };
  if (sections.metrics.status !== 'ok') problems.push('metrics missing');

  // ── signal ─────────────────────────────────────────────────────
  const signal = layers.signal;
  sections.signal = signal && typeof signal === 'object'
    ? { status: 'ok' } : { status: 'fail', error: 'signal block missing' };
  if (sections.signal.status !== 'ok') problems.push('signal missing');

  // ── moveLive ───────────────────────────────────────────────────
  const moveLive = layers.moveLive;
  sections.moveLive = moveLive
    ? { status: 'ok' } : { status: 'warning', notes: 'no active move event (may be normal)' };

  // ── presignal ──────────────────────────────────────────────────
  const presignal = layers.presignal;
  if (presignal && typeof presignal === 'object') {
    const hasAdj = presignal.adjustedReadinessScore != null;
    const hasLabel = !!presignal.readinessLabel;
    sections.presignal = hasAdj && hasLabel
      ? { status: 'ok' }
      : { status: 'warning', notes: `missing: ${!hasAdj ? 'adjustedReadinessScore ' : ''}${!hasLabel ? 'readinessLabel' : ''}` };
    if (!hasAdj) problems.push('presignal.adjustedReadinessScore missing');
  } else {
    sections.presignal = { status: 'warning', notes: 'no active pre-signal (may be normal)' };
  }

  // ── ranking ────────────────────────────────────────────────────
  const rankingData = ranking ?? payload.ranking;
  const hasRanking  = rankingData && (rankingData.happened || rankingData.building);
  sections.ranking  = hasRanking
    ? { status: 'ok' } : { status: 'warning', notes: 'ranking block absent (needs active event/presignal)' };

  // ── derivatives ────────────────────────────────────────────────
  const derivatives = layers.derivatives;
  if (derivatives && typeof derivatives === 'object') {
    const hasFunding = derivatives.fundingRate != null;
    const hasOi      = derivatives.oiValue     != null;
    const hasBias    = !!derivatives.derivativesBias;
    const allOk      = hasFunding && hasOi && hasBias;
    sections.derivatives = allOk
      ? { status: 'ok' }
      : { status: 'warning', notes: `incomplete: ${!hasFunding?'fundingRate ':''} ${!hasOi?'oiValue ':''} ${!hasBias?'derivativesBias':''}`.trim() };
    if (!allOk) problems.push('derivatives block incomplete');
  } else {
    sections.derivatives = { status: 'warning', notes: 'derivatives data not yet available' };
  }

  // ── debug/explain ──────────────────────────────────────────────
  const explainData = explain ?? payload.explain;
  sections.debug = explainData
    ? { status: 'ok' } : { status: 'warning', notes: 'explain block missing (needs active event/presignal)' };

  // ── completeness score ─────────────────────────────────────────
  const weights = { price: 20, metrics: 20, signal: 20, moveLive: 10, presignal: 10, derivatives: 10, ranking: 5, debug: 5 };
  let score = 0;
  for (const [k, w] of Object.entries(weights)) {
    if (sections[k]?.status === 'ok') score += w;
    else if (sections[k]?.status === 'warning') score += Math.floor(w * 0.5);
  }

  const status = problems.some(p => p.includes('missing') && !p.includes('active'))
    ? 'warning' : 'ok';

  return { status, sections, problems, completenessScore: score };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.4  buildQaSummary(reportItems)
// each item: { status: 'ok'|'warning'|'fail', label?: string }
// ─────────────────────────────────────────────────────────────────────────────
function buildQaSummary(reportItems) {
  let okCount = 0, warningCount = 0, failCount = 0;
  for (const item of reportItems) {
    if      (item.status === 'ok')      okCount++;
    else if (item.status === 'warning') warningCount++;
    else                                failCount++;
  }
  const totalChecks   = reportItems.length;
  const summaryStatus = failCount > 0 ? 'fail' : warningCount > 0 ? 'warning' : 'ok';
  return { totalChecks, okCount, warningCount, failCount, summaryStatus };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-key rules catalogue
// ─────────────────────────────────────────────────────────────────────────────
const REDIS_RULES = {
  'move:live': {
    requiredFields: ['symbol', 'ts'],
    numericFields : [],
    maxAgeMs      : MAX_MOVE_STALE_MS,
  },
  'presignal': {
    requiredFields: ['symbol', 'ts', 'signalType', 'adjustedReadinessScore', 'confidenceScore', 'readinessLabel'],
    numericFields : ['adjustedReadinessScore', 'confidenceScore'],
    maxAgeMs      : MAX_PRESIGNAL_STALE_MS,
  },
  'derivatives': {
    requiredFields: ['symbol', 'ts', 'fundingRate', 'oiValue', 'derivativesBias', 'squeezeRisk'],
    numericFields : ['fundingRate', 'oiValue', 'squeezeRisk'],
    maxAgeMs      : MAX_DERIVATIVES_STALE_MS,
  },
  'screener:rank:happened': {
    arraysNonEmpty: [],   // empty array is acceptable
    maxAgeMs      : 120000,
  },
  'screener:rank:building': {
    arraysNonEmpty: [],
    maxAgeMs      : 60000,
  },
  'events:recent': {
    arraysNonEmpty: [],
    maxAgeMs      : 30000,
  },
  'outcome:stats': {
    requiredFields: ['total', 'converted', 'watchingCount'],
    maxAgeMs      : 180000,
  },
};

function getRulesFor(keyBase) {
  return REDIS_RULES[keyBase] || {};
}

module.exports = {
  validateServiceState,
  validateRedisPayload,
  validateTesttestSymbolPayload,
  buildQaSummary,
  getRulesFor,
  // Expose constants for consumers
  MAX_SERVICE_STALE_MS,
  MAX_PRESIGNAL_STALE_MS,
  MAX_MOVE_STALE_MS,
  MAX_DERIVATIVES_STALE_MS,
  MAX_PAYLOAD_STALE_MS,
};
