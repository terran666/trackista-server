# EXTREMES_AND_LEVELS_ARCHITECTURE

## 1. Goal
Backend audit and synchronization map for TestPage data (Extremes/Levels) and Formations inputs before rewriting Formations engine.

Primary outcome:
- show exactly what TestPage writes and reads,
- show exactly what Formations consumes,
- expose parity endpoints for backend audit,
- produce SLXUSDT 5m evidence snapshot.

## 2. System Map (TestPage -> Store -> Formations)
Core backend files:
- `backend/src/services/trackedExtremesStore.js`
- `backend/src/services/trackedLevelsStore.js`
- `backend/src/services/manualLevelsStore.js`
- `backend/src/routes/debugExtremesLevelsRoute.js`
- `backend/src/formations/formationScalpingService.js`
- `backend/src/formations/patternEngine/formationPatternEngine.js`
- `backend/src/formations/patternEngine/strategies/doubleExtremeStrategy.js`
- `backend/src/formations/formationRoutes.js`
- `backend/src/formations/sourceAudit.js`
- `backend/src/routes/formationsCompareSourceRoute.js`
- `backend/src/routes/liveWsGateway.js`

Frontend availability in this workspace:
- only dist artifacts (`frontend/dist/*`) are present,
- full source-level React/Vue components are not present.

## 3. Stage 1: TestPage Extremes Write/Read Contract
Write path:
1. TestPage computes extremes and sends `POST /api/tracked-extremes/bulk`.
2. `trackedExtremesStore.bulkSave` persists in `backend/data/tracked-extremes.json`.

Read path:
1. TestPage calls `GET /api/tracked-extremes` with `symbol/tf/marketType`.
2. Data is rendered as highs/lows overlays.

Persisted fields used by audit:
- `symbol`, `marketType`, `tf`, `source`, `side`, `type`, `price`, `touches`, `strength`, `points`.

## 4. Stage 2: TestPage Levels Write/Read Contract
Tracked levels path:
1. `GET /api/autolevels` (calculation source).
2. `POST /api/tracked-levels/bulk`.
3. persisted in `backend/data/tracked-levels.json`.

Manual levels path:
1. `POST /api/manual-levels`.
2. persisted in `backend/data/manual-levels.json`.

Read path:
- `GET /api/tracked-levels`, `GET /api/manual-levels`.

## 5. Stage 3: Formations Input Contract (Current)
Pattern engine (active path):
- Formations reads tracked extremes via `trackedExtremesStore.getAll` in `formationScalpingService.refreshPatternExtremes`.
- Pattern detection is done by `doubleExtremeStrategy` (`High-Low-High`, `Low-High-Low`).

Important current behavior:
- pattern detection uses extremes;
- support/resistance used in pattern output are derived from pattern geometry (`levels.resistanceLevel/supportLevel/neckline/breakout/invalidation`), not read from tracked/manual levels as direct pattern input.

Legacy note:
- service still refreshes stored levels for legacy V3 engine path, but this is separate from V1 pattern detection logic.

## 6. Stage 4: New Audit Endpoint (Required)
Implemented:
- `GET /api/formations/compare-source?symbol=...&tf=...&marketType=...`

Implementation:
- route handler: `backend/src/routes/formationsCompareSourceRoute.js`
- server registration: `backend/src/server.js`
- source audit builder: `backend/src/formations/sourceAudit.js`

Response includes:
- `counts.testPage` (extremes/levels/highs/lows/supports/resistances),
- `counts.formations` (extremes/derived-levels/candidates),
- `mismatches[]` with typed entries:
  - `LEVEL_MISSING_IN_FORMATIONS`
  - `LEVEL_EXTRA_IN_FORMATIONS`
- `quality` blocks,
- `decisionTrace` block.

## 7. Stage 5: New Formation Source Debug Mode (Required)
Implemented:
- `GET /api/formations/debug/source?symbol=...&tf=...&marketType=...`

Implementation:
- route in `backend/src/formations/formationRoutes.js`
- powered by `backend/src/formations/sourceAudit.js`

Debug payload includes all required source buckets:
- TestPage `highs`, `lows`, `supports`, `resistances`, full `extremes`, full `levels`.
- Formations `candidates`, derived `levels`, `tfSummary`, `statsByTf`.
- normalized fields include `source`, `touches`, `strength`, `status`.

## 8. Stage 6: Decision Trace (Step 10 Requirement)
Decision trace payload now includes:
- `selectedPattern` (best scored accepted candidate),
- `whySelected[]` (key selected metrics),
- `rejectedPatterns[]` with rejection reasons,
- `rejectedByReason` aggregated counters.

This is produced in `sourceAudit.collectDecisionTrace` from `diagnosePatterns().debugByTf` + `candidates`.

## 9. Stage 7: Quality Rules and Validation
Quality checks in `sourceAudit`:
- extremes: missing/invalid `price`, missing `type|side`, missing `source`, non-positive `touches/strength`.
- levels: same checks for tracked-level quality (`touches` + `score->strength`) and base structural checks for all levels.

Output:
- `quality.extremes`
- `quality.levels`

## 10. Stage 8: Redis / API / WS Delivery Map
Redis keys for Formations:
- `formations:scalping:active`
- `formations:scalping:symbol:{symbol}`
- `formations:scalping:id:{id}`

REST endpoints (relevant):
- `GET /api/formations/scalping`
- `GET /api/formations/debug`
- `GET /api/formations/debug/patterns`
- `GET /api/formations/debug/source`
- `GET /api/formations/compare-source`

WebSocket channel:
- `liveWsGateway` flushes `formations:snapshot` and `formations:update` from Redis keys above.

---

## 11. SLXUSDT 5m Root Cause Analysis

**Case:** TestPage shows support ~0.33, Formations backend uses 0.30569 as support. Engine produces 0 formations and no SHORT signal.

### 11.1 Extreme Snapshot (2026-06-02, 5m)

| ID   | Side       | Price   | Time (UTC)          | Source     |
|------|------------|---------|---------------------|------------|
| 5524 | SUPPORT    | 0.29582 | 09:15               | extremes   |
| 5525 | SUPPORT    | 0.32861 | 12:55               | extremes   |
| 5526 | SUPPORT    | 0.33193 | 13:50               | extremes   |
| 5527 | RESISTANCE | 0.38811 | 15:15               | extremes   |
| 5528 | RESISTANCE | 0.35876 | 17:00               | extremes   |
| 5529 | RESISTANCE | 0.34353 | 19:05               | extremes   |

Tracked support from `autolevels`: **0.30569** — computed at **10:25:00** (before extremes 5525 and 5526 existed).

Tracked resistances from `autolevels`: 0.38811 (score=3.24, touches=2), 0.42633 (score=1.32), 0.43294 (score=1.33).

Manual levels: **empty**.

### 11.2 Root Cause #1 — No Patterns (0 formations created)

The engine scans extremes in **array order** for H-L-H (Double Top) or L-H-L (Double Bottom).

Current extreme structure in time/array order:
```
L(09:15) → L(12:55) → L(13:50) → H(15:15) → H(17:00) → H(19:05)
```
Pattern = **L-L-L-H-H-H** = price RISE from bottom. This is not a Double Top or Double Bottom structure.

- Zero H-L-H triplets → zero Double Top candidates
- Zero L-H-L triplets → zero Double Bottom candidates
- **Engine is CORRECT to return 0 patterns.** The extreme sequence does not match any Double-pattern archetype.

### 11.3 Root Cause #2 — 0.33 vs 0.30569 Discrepancy

These are **two different objects** from two different systems:

| What          | Price   | Source                 | Computed at   |
|---------------|---------|------------------------|---------------|
| Visual "0.33" | ~0.33   | Extreme cluster 5525+5526 | 12:55–13:50 |
| Backend support | 0.30569 | `autolevels` tracked-level | **10:25** (150 min earlier) |

**Why the stale value persists:**
- `autolevels` is computed by the Levels Engine from OHLCV bars, triggered only when TestPage calls `POST /api/tracked-levels/bulk`.
- The Formations engine does **not** automatically re-run `autolevels` when new extremes arrive.
- Extremes 5525 (0.32861) and 5526 (0.33193) were created at 12:55 and 13:50 — **after** the snapshot that produced 0.30569.
- The tracked-level store is therefore stale and does not reflect the new support cluster.

**Key insight:** The "0.33 support" visible on the chart is the **extreme cluster** (two extremes within 0.99% of each other), not a tracked-level. TestPage renders both extremes and tracked-levels. Users see the extremes visually and read them as "support". The backend only treats `tracked-levels` as support, not raw extremes.

### 11.4 Root Cause #3 — No SHORT Signal (Architectural Gap)

The current pattern engine only has one strategy: **`doubleExtremeStrategy`**.

Available patterns and their signals:
- `DOUBLE_TOP` → direction = `SHORT_BREAKDOWN`
- `DOUBLE_BOTTOM` → direction = `LONG_BREAKOUT`

Missing strategies needed for breakdown signals:
- `SUPPORT_BREAKDOWN` — no such strategy exists
- `BEAR_FLAG` — no such strategy exists
- `RESISTANCE_REJECTION` — no such strategy exists

**Even if price clearly drops below 0.33, the engine CANNOT produce a SHORT signal.** It can only produce SHORT via a confirmed Double Top (H-L-H structure), which doesn't exist in the current data.

### 11.5 Breakout Table (if currentPrice ≈ 0.330)

| Level   | Source          | distancePct | isBroken |
|---------|-----------------|-------------|----------|
| 0.33193 | extreme #5526   | −0.58%      | **true** |
| 0.32861 | extreme #5525   | +0.42%      | false    |
| 0.30569 | autolevels      | +7.95%      | false    |

The engine does not see 0.33193 as a **level** — only as a raw extreme. There is no tracked-level entry for 0.33. So even if a "breakdown check" were added to the engine, it would still use 0.30569 from tracked-levels and conclude "support is intact".

### 11.6 What Needs to Be Fixed (New Engine Requirements)

1. **Auto-update tracked-levels when new extremes arrive** — or derive support/resistance directly from extreme clusters rather than from stale `autolevels`.
2. **Add `SUPPORT_BREAKDOWN` strategy** — scan for a significant support extreme cluster that price has now broken below.
3. **Add `RESISTANCE_REJECTION` strategy** — scan for a resistance cluster that price was rejected from (lower high pattern).
4. **Extreme cluster aggregation** — when two or more extremes are within `tolerancePct` (e.g., 1.5%) of each other, treat them as a single visual level. Expose `avgPrice`, `ids[]`, `isCluster` in API.
5. **Use extreme cluster prices as level inputs** — when `autolevels` is stale (>N minutes since last refresh), fall back to extreme cluster prices for support/resistance decisions.

### 11.7 New API Fields (from sourceAudit.js)

The `GET /api/formations/compare-source?symbol=SLXUSDT&tf=5m` endpoint now returns:

- `visibleSupports[]` — all support sources (extremes + tracked-levels) with `distancePct`, `isBroken`, `breakoutStatus`, `category`, `source`
- `visibleResistances[]` — same for resistance
- `extremeClusters[]` — auto-detected clusters with `avgPrice`, `ids[]`, `count`, `isCluster`, `visualLabel`
- `currentPrice` — estimated from latest extreme point (proxy for ticker price)
- `decisionTrace.whyNoShort[]` — explains why no SHORT signal was produced
- `decisionTrace.selectedPattern.levels.resistanceSource` / `.supportSource` — annotates whether each level came from extremes-avg or tracked-level store
- `decisionTrace.totalCandidates`, `.longCandidates`, `.shortCandidates`


## 11. Stage 9: SLXUSDT 5m Audit Snapshot
Store snapshot (`backend/data/*` at audit time):
- extremes: `6`
- tracked levels: `4`
- manual levels: `0`

Price lists:
- extremes highs: `[0.38811, 0.35876, 0.34353]`
- extremes lows: `[0.29582, 0.32861, 0.33193]`
- tracked resistances: `[0.38811, 0.42633, 0.43294]`
- tracked supports: `[0.30569]`

Formations debug evidence (previous run in this session):
- `GET /api/formations/debug?symbol=SLXUSDT&tf=5m`
- extremes total `6`, valid `6`, rejected `0`
- patterns created: `0`

Interpretation:
- extremes feed parity is present,
- no pattern passed acceptance filters for that snapshot,
- issue is not missing source transport, but strategy gates/conditions.

## 12. Stage 10-12: Acceptance Checklist
Implemented now:
- `GET /api/formations/compare-source` exists and returns counts + `mismatches[]`.
- Formation source debug mode exists at `GET /api/formations/debug/source`.
- Decision trace block exists (`selectedPattern`, `whySelected`, `rejectedPatterns`).
- Architecture document includes TestPage -> store -> Formations flow, API, Redis, WS map, and SLXUSDT 5m section.

Operational notes:
- If backend process is already running, restart is required to load new routes.
- Frontend source is absent in this workspace; visual parity for drawing layer is validated through backend data and dist-level diagnostics.
