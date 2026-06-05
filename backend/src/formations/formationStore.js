'use strict';

/**
 * formationStore.js — Redis persistence for formations.
 *
 * Keys:
 *   formations:scalping:active            — Set of active formation ids
 *   formations:scalping:symbol:{symbol}   — Set of ids for one symbol
 *   formations:scalping:id:{id}           — JSON blob (TTL = config.expireMs)
 *
 * Legacy fingerprint (V2/V3 geometry):
 *   symbol:marketType:direction:levelPrice
 *
 * Pattern fingerprint (V1 pattern engine):
 *   symbol:marketType:tf:patternType:tsA:tsB:tsC
 *   (provided directly by the strategy — see doubleExtremeStrategy.js)
 */

const ACTIVE_KEY = 'formations:scalping:active';
const symbolKey  = (s)  => `formations:scalping:symbol:${s}`;
const idKey      = (id) => `formations:scalping:id:${id}`;

/** Legacy fingerprint builder (V2/V3 price-proximity formations). */
function buildFingerprint({ symbol, marketType, direction, levelPrice }) {
  return `${symbol}:${marketType}:${direction}:${levelPrice}`;
}

function createFormationStore(redis, config) {
  const ttlSec = Math.ceil(config.expireMs / 1000);

  function tryParse(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async function getById(id) {
    return tryParse(await redis.get(idKey(id)));
  }

  /** Fetch every active formation (parsed). Prunes ids whose blob expired. */
  async function getActive() {
    const ids = await redis.smembers(ACTIVE_KEY);
    if (!ids.length) return [];
    const pipe = redis.pipeline();
    for (const id of ids) pipe.get(idKey(id));
    const res = await pipe.exec();
    const out = [];
    const stale = [];
    for (let i = 0; i < ids.length; i++) {
      const f = tryParse(res[i]?.[1]);
      if (f) out.push(f);
      else stale.push(ids[i]);
    }
    if (stale.length) {
      const p = redis.pipeline();
      for (const id of stale) p.srem(ACTIVE_KEY, id);
      await p.exec();
    }
    return out;
  }

  async function getBySymbol(symbol) {
    const ids = await redis.smembers(symbolKey(symbol));
    if (!ids.length) return [];
    const pipe = redis.pipeline();
    for (const id of ids) pipe.get(idKey(id));
    const res = await pipe.exec();
    return res.map(r => tryParse(r?.[1])).filter(Boolean);
  }

  /**
   * Upsert a candidate. If a formation with the same fingerprint exists, update
   * it in place (preserve id + createdAt). Otherwise create a new one.
   *
   * Works for both legacy (V2/V3) and V1 pattern formations.
   * @returns {{ formation, created: boolean }}
   */
  async function upsert(candidate, existingByFingerprint) {
    const now = Date.now();
    const fingerprint = candidate.fingerprint;
    const prev = existingByFingerprint?.get(fingerprint);

    const patternTtlSec = candidate.patternType
      ? (candidate.ttlSec ?? Math.ceil((config.patternEngine?.doubleExtreme?.maxPatternAgeHours ?? 120) * 3600))
      : ttlSec;

    let formation;
    let created;
    if (prev) {
      created = false;
      if (candidate.patternType) {
        // V1 pattern: update price, status, metrics only
        formation = {
          ...prev,
          status:       candidate.status,
          currentPrice: candidate.currentPrice ?? prev.currentPrice,
          breakLevel:   candidate.breakLevel   ?? prev.breakLevel,
          breakDirection: candidate.breakDirection ?? prev.breakDirection,
          levelId:      candidate.levelId      ?? prev.levelId,
          levelSource:  candidate.levelSource  ?? prev.levelSource,
          levelTf:      candidate.levelTf      ?? prev.levelTf,
          sourceTf:     candidate.sourceTf     ?? prev.sourceTf ?? null,
          confluenceTf: candidate.confluenceTf ?? prev.confluenceTf ?? null,
          debugTfReason: candidate.debugTfReason ?? prev.debugTfReason ?? null,
          levelType:    candidate.levelType    ?? prev.levelType,
          levelPrice:   candidate.levelPrice   ?? prev.levelPrice,
          extremeId:    candidate.extremeId    ?? prev.extremeId    ?? null,
          extremePrice: candidate.extremePrice  ?? prev.extremePrice  ?? null,
          extremeType:  candidate.extremeType  ?? prev.extremeType  ?? null,
          extremeTf:    candidate.extremeTf    ?? prev.extremeTf    ?? null,
          extremeTime:  candidate.extremeTime  ?? prev.extremeTime  ?? null,
          extremeBarIndex: candidate.extremeBarIndex ?? prev.extremeBarIndex ?? null,
          extremeIds:   candidate.extremeIds   ?? prev.extremeIds   ?? null,
          extremeSource: candidate.extremeSource ?? prev.extremeSource ?? null,
          isVisibleOnTestPage: candidate.isVisibleOnTestPage ?? prev.isVisibleOnTestPage,
          visibleOnTestPage: candidate.visibleOnTestPage ?? prev.visibleOnTestPage ?? candidate.isVisibleOnTestPage ?? prev.isVisibleOnTestPage ?? null,
          supportLevel: candidate.supportLevel ?? prev.supportLevel,
          supportSource: candidate.supportSource ?? prev.supportSource,
          resistanceLevel: candidate.resistanceLevel ?? prev.resistanceLevel,
          resistanceSource: candidate.resistanceSource ?? prev.resistanceSource,
          touches:      candidate.touches      ?? prev.touches,
          strength:     candidate.strength     ?? prev.strength,
          touchPoints:  candidate.touchPoints  ?? prev.touchPoints,
          candidateTouches: candidate.candidateTouches ?? prev.candidateTouches ?? null,
          independentTouches: candidate.independentTouches ?? prev.independentTouches,
          touchClusterCount: candidate.touchClusterCount ?? prev.touchClusterCount,
          touchTimeSpreadBars: candidate.touchTimeSpreadBars ?? prev.touchTimeSpreadBars,
          touchTimeSpreadMinutes: candidate.touchTimeSpreadMinutes ?? prev.touchTimeSpreadMinutes,
          barsCrossedCount: candidate.barsCrossedCount ?? prev.barsCrossedCount,
          cleanTouchCount: candidate.cleanTouchCount ?? prev.cleanTouchCount,
          bodyCrossCount: candidate.bodyCrossCount ?? prev.bodyCrossCount,
          wickTouchCount: candidate.wickTouchCount ?? prev.wickTouchCount,
          zoneLower:    candidate.zoneLower    ?? prev.zoneLower,
          zoneUpper:    candidate.zoneUpper    ?? prev.zoneUpper,
          tolerancePct: candidate.tolerancePct ?? prev.tolerancePct,
          levelAgeBars: candidate.levelAgeBars ?? prev.levelAgeBars,
          levelAgeMinutes: candidate.levelAgeMinutes ?? prev.levelAgeMinutes,
          firstTouchTime: candidate.firstTouchTime ?? prev.firstTouchTime,
          lastTouchTime: candidate.lastTouchTime ?? prev.lastTouchTime,
          avgReactionPct: candidate.avgReactionPct ?? prev.avgReactionPct,
          maxReactionPct: candidate.maxReactionPct ?? prev.maxReactionPct,
          distancePct:  candidate.distancePct  ?? prev.distancePct,
          breakdownPct: candidate.breakdownPct ?? prev.breakdownPct,
          breakoutPct:  candidate.breakoutPct  ?? prev.breakoutPct,
          metrics:      candidate.metrics      ?? prev.metrics,
          debug:        candidate.debug        ?? prev.debug,
          levels:       candidate.levels       ?? prev.levels,
          lifecycleStatus: candidate.lifecycleStatus ?? prev.lifecycleStatus ?? null,
          lifecycleReason: candidate.lifecycleReason ?? prev.lifecycleReason ?? null,
          breakDetectedAt: candidate.breakDetectedAt ?? prev.breakDetectedAt ?? null,
          selectedLevel: candidate.selectedLevel ?? prev.selectedLevel ?? null,
          selectedExtremes: candidate.selectedExtremes ?? prev.selectedExtremes ?? null,
          chartRange:   candidate.chartRange   ?? prev.chartRange,
          score:        candidate.score        ?? prev.score,
          updatedAt:    now,
          expiresAt:    now + patternTtlSec * 1000,
        };
      } else {
        // Legacy V2/V3
        formation = {
          ...prev,
          status:      candidate.status,
          price:       candidate.price,
          currentPrice: candidate.price,
          distancePct: candidate.distancePct,
          probability: candidate.probability,
          score:       candidate.score,
          signals:     candidate.signals,
          tradePlan:   candidate.tradePlan,
          reason:      candidate.reason,
          level:       candidate.level,
          breakout:    candidate.breakout,
          strategy:    candidate.strategy,
          type:        candidate.type,
          confluenceStrategies: candidate.confluenceStrategies,
          multiSignalBonus:     candidate.multiSignalBonus,
          confluenceBonus:      candidate.confluenceBonus,
          zoneBonus:            candidate.zoneBonus,
          levelStrength:        candidate.levelStrength,
          confluenceScore:      candidate.confluenceScore,
          version:     candidate.version || 'v2',
          lastAnalyzedAt: candidate.lastAnalyzedAt ?? prev.lastAnalyzedAt ?? now,
          nextAnalyzeAt:  candidate.nextAnalyzeAt ?? prev.nextAnalyzeAt ?? now,
          updatedAt:   now,
          expiresAt:   now + config.expireMs,
        };
      }
    } else {
      created = true;
      const id = candidate.id || (candidate.patternType
        ? `${candidate.symbol}_${candidate.tf}_${candidate.patternType}`
        : fingerprint);
      if (candidate.patternType) {
        // V1 pattern formation
        formation = {
          id,
          fingerprint,
          symbol:       candidate.symbol,
          marketType:   candidate.marketType,
          tf:           candidate.tf,
          patternType:  candidate.patternType,
          strategy:     candidate.strategy,
          direction:    candidate.direction,
          status:       candidate.status,
          breakLevel:   candidate.breakLevel ?? null,
          breakDirection: candidate.breakDirection ?? null,
          levelId:      candidate.levelId ?? null,
          levelSource:  candidate.levelSource ?? null,
          levelTf:      candidate.levelTf ?? null,
          sourceTf:     candidate.sourceTf ?? null,
          confluenceTf: candidate.confluenceTf ?? null,
          debugTfReason: candidate.debugTfReason ?? null,
          levelType:    candidate.levelType ?? null,
          levelPrice:   candidate.levelPrice ?? null,
          extremeId:    candidate.extremeId    ?? null,
          extremePrice: candidate.extremePrice  ?? null,
          extremeType:  candidate.extremeType  ?? null,
          extremeTf:    candidate.extremeTf    ?? null,
          extremeTime:  candidate.extremeTime  ?? null,
          extremeBarIndex: candidate.extremeBarIndex ?? null,
          extremeIds:   candidate.extremeIds   ?? null,
          extremeSource: candidate.extremeSource ?? null,
          isVisibleOnTestPage: candidate.isVisibleOnTestPage ?? null,
          visibleOnTestPage: candidate.visibleOnTestPage ?? candidate.isVisibleOnTestPage ?? null,
          supportLevel: candidate.supportLevel ?? null,
          supportSource: candidate.supportSource ?? null,
          resistanceLevel: candidate.resistanceLevel ?? null,
          resistanceSource: candidate.resistanceSource ?? null,
          touches:      candidate.touches ?? null,
          strength:     candidate.strength ?? null,
          touchPoints:  candidate.touchPoints ?? null,
          candidateTouches: candidate.candidateTouches ?? null,
          independentTouches: candidate.independentTouches ?? null,
          touchClusterCount: candidate.touchClusterCount ?? null,
          touchTimeSpreadBars: candidate.touchTimeSpreadBars ?? null,
          touchTimeSpreadMinutes: candidate.touchTimeSpreadMinutes ?? null,
          barsCrossedCount: candidate.barsCrossedCount ?? null,
          cleanTouchCount: candidate.cleanTouchCount ?? null,
          bodyCrossCount: candidate.bodyCrossCount ?? null,
          wickTouchCount: candidate.wickTouchCount ?? null,
          zoneLower:    candidate.zoneLower ?? null,
          zoneUpper:    candidate.zoneUpper ?? null,
          tolerancePct: candidate.tolerancePct ?? null,
          levelAgeBars: candidate.levelAgeBars ?? null,
          levelAgeMinutes: candidate.levelAgeMinutes ?? null,
          firstTouchTime: candidate.firstTouchTime ?? null,
          lastTouchTime: candidate.lastTouchTime ?? null,
          avgReactionPct: candidate.avgReactionPct ?? null,
          maxReactionPct: candidate.maxReactionPct ?? null,
          distancePct:  candidate.distancePct ?? null,
          breakdownPct: candidate.breakdownPct ?? null,
          breakoutPct:  candidate.breakoutPct ?? null,
          levels:       candidate.levels,
          selectedLevel: candidate.selectedLevel ?? null,
          selectedExtremes: candidate.selectedExtremes ?? null,
          points:       candidate.points ?? null,
          metrics:      candidate.metrics  ?? null,
          debug:        candidate.debug    ?? null,
          chartRange:   candidate.chartRange ?? null,
          lifecycleStatus: candidate.lifecycleStatus ?? null,
          lifecycleReason: candidate.lifecycleReason ?? null,
          breakDetectedAt: candidate.breakDetectedAt ?? null,
          score:        candidate.score,
          currentPrice: candidate.currentPrice ?? null,
          source:       candidate.source  || 'patternEngine',
          version:      candidate.version || 'v1',
          createdAt:    now,
          updatedAt:    now,
          expiresAt:    now + patternTtlSec * 1000,
        };
      } else {
        // Legacy V2/V3
        formation = {
          id,
          fingerprint,
          symbol:      candidate.symbol,
          marketType:  candidate.marketType,
          style:       config.style,
          strategy:    candidate.strategy,
          type:        candidate.type,
          direction:   candidate.direction,
          status:      candidate.status,
          version:     candidate.version || 'v2',
          price:       candidate.price,
          createdPrice: candidate.price,
          currentPrice: candidate.price,
          level:       candidate.level,
          breakout:    candidate.breakout,
          distancePct: candidate.distancePct,
          probability: candidate.probability,
          score:       candidate.score,
          confluenceStrategies: candidate.confluenceStrategies,
          multiSignalBonus:     candidate.multiSignalBonus,
          confluenceBonus:      candidate.confluenceBonus,
          zoneBonus:            candidate.zoneBonus,
          levelStrength:        candidate.levelStrength,
          confluenceScore:      candidate.confluenceScore,
          signals:     candidate.signals,
          tradePlan:   candidate.tradePlan,
          reason:      candidate.reason,
          lastAnalyzedAt: candidate.lastAnalyzedAt ?? now,
          nextAnalyzeAt:  candidate.nextAnalyzeAt ?? now,
          createdAt:   now,
          updatedAt:   now,
          expiresAt:   now + config.expireMs,
        };
      }
    }

    await save(formation, patternTtlSec);
    return { formation, created };
  }

  async function save(formation, customTtlSec) {
    const ttl = customTtlSec ?? ttlSec;
    const pipe = redis.pipeline();
    pipe.set(idKey(formation.id), JSON.stringify(formation), 'EX', ttl);
    pipe.sadd(ACTIVE_KEY, formation.id);
    pipe.sadd(symbolKey(formation.symbol), formation.id);
    pipe.expire(symbolKey(formation.symbol), ttl);
    await pipe.exec();
  }

  async function remove(formation) {
    const pipe = redis.pipeline();
    pipe.del(idKey(formation.id));
    pipe.srem(ACTIVE_KEY, formation.id);
    pipe.srem(symbolKey(formation.symbol), formation.id);
    await pipe.exec();
  }

  return { buildFingerprint, getById, getActive, getBySymbol, upsert, save, remove };
}

module.exports = { createFormationStore, buildFingerprint };
