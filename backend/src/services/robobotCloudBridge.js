'use strict';
/**
 * robobotCloudBridge.js — sends triggered Robobot tasks to the Cloud Decision
 * Server. Falls back to a mock mode if ROBOBOT_CLOUD_URL is not configured.
 *
 *   POST {ROBOBOT_CLOUD_URL}/robobot/task
 */

const CLOUD_URL    = process.env.ROBOBOT_CLOUD_URL || '';
const TIMEOUT_MS   = parseInt(process.env.ROBOBOT_CLOUD_TIMEOUT_MS || '3000', 10);
const MAX_RETRIES  = parseInt(process.env.ROBOBOT_CLOUD_MAX_RETRIES || '3', 10);

const isMock = () => !CLOUD_URL;

function buildPayload(task, triggeredAt) {
  return {
    taskId           : task.id,
    symbol           : task.symbol,
    market           : task.market,
    scenario         : task.scenario,
    direction        : task.direction,
    levelPrice       : task.levelPrice,
    triggerType      : task.triggerType,
    entry            : task.entry || { type: 'market' },
    stopLossPrice    : task.stopLossPrice,
    takeProfitPrice  : task.takeProfitPrice,
    positionSizeUsdt : task.positionSizeUsdt,
    riskConfig       : task.riskConfig || {},
    triggeredAt      : (triggeredAt instanceof Date ? triggeredAt : new Date(triggeredAt || Date.now())).toISOString(),
  };
}

async function postOnce(payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${CLOUD_URL.replace(/\/+$/, '')}/robobot/task`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(payload),
      signal  : ctrl.signal,
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`cloud_http_${res.status}`);
      err.status = res.status;
      err.body   = body;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a task to Cloud (with retries). Returns:
 *   { ok:true,  mock:false, response }
 *   { ok:true,  mock:true,  response }
 *   { ok:false, error, attempts }
 */
async function sendTaskToCloud(task, { triggeredAt } = {}) {
  const payload = buildPayload(task, triggeredAt);

  if (isMock()) {
    console.log(`[robobotCloud] MOCK send taskId=${task.id} symbol=${task.symbol} payload=${JSON.stringify(payload)}`);
    return { ok: true, mock: true, response: { status: 'mock_ok' } };
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[robobotCloud] send taskId=${task.id} attempt=${attempt}/${MAX_RETRIES}`);
      const response = await postOnce(payload);
      console.log(`[robobotCloud] OK taskId=${task.id} response=${JSON.stringify(response).slice(0, 500)}`);
      return { ok: true, mock: false, response };
    } catch (err) {
      lastErr = err;
      console.error(`[robobotCloud] FAIL taskId=${task.id} attempt=${attempt}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 250 * attempt));
      }
    }
  }
  return { ok: false, error: lastErr?.message || 'unknown', attempts: MAX_RETRIES };
}

function getCloudMode() { return isMock() ? 'mock' : 'real'; }

module.exports = { sendTaskToCloud, getCloudMode };
