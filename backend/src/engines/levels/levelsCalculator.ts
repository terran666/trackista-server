import type { Bar } from "../../shared/types"
import type { CalculateLevelsParams, Level, LevelsConfig } from "./types"

import { mergeConfig } from "./config"
import { findPivots } from "./pivots"
import { clusterPivotsByPrice, median, priceTolerance } from "./clustering"

function clampBars(bars: Bar[]): Bar[] {
  return bars.filter(
    b =>
      Number.isFinite(b.time) &&
      Number.isFinite(b.close) &&
      b.time > 0
  )
}

function countTouches(prices: number[], levelPrice: number, tolAbs: number): number {
  let c = 0

  for (let i = 0; i < prices.length; i++) {
    if (Math.abs(prices[i] - levelPrice) <= tolAbs) c++
  }

  return c
}

function timeSpanBonus(indices: number[], totalLen: number): number {
  if (indices.length < 2) return 0

  const minI = Math.min(...indices)
  const maxI = Math.max(...indices)

  const span = maxI - minI

  return totalLen > 1 ? span / (totalLen - 1) : 0
}

function filterCloseLevels(levels: Level[], minDistPercent: number): Level[] {

  const sorted = [...levels].sort((a, b) => b.strength - a.strength)

  const kept: Level[] = []

  for (const lvl of sorted) {

    const tooClose = kept.some(k => {

      const tol = priceTolerance(k.price, minDistPercent)

      return Math.abs(lvl.price - k.price) <= tol

    })

    if (!tooClose) kept.push(lvl)
  }

  return kept.sort((a, b) => a.price - b.price)
}

export function calculateLevels(params: CalculateLevelsParams): Level[] {

  const config = mergeConfig(params.config)

  const bars = clampBars(params.bars)

  if (bars.length < config.pivotLeft + config.pivotRight + 5) return []

  const closes = bars.map(b => b.close)

  // 1) pivots
  const pivots = findPivots(closes, config.pivotLeft, config.pivotRight)

  // 2) cluster pivots
  const clusters = clusterPivotsByPrice(pivots, config.tolerancePercent)

  const fromTs = bars[0].time
  const toTs = bars[bars.length - 1].time

  const candidates: Level[] = []

  for (const cl of clusters) {

    const pivotsCount = cl.prices.length

    if (pivotsCount < config.minPivotsInCluster) continue

    const price = median(cl.prices)

    const tolAbs = priceTolerance(price, config.tolerancePercent)

    const touches = countTouches(closes, price, tolAbs)

    if (touches < config.minTouches) continue

    const spanBonus = timeSpanBonus(cl.indices, closes.length)

    const strength =
      config.wPivots * pivotsCount +
      config.wTouches * touches +
      config.wSpan * spanBonus

    candidates.push({
      price,
      type: params.levelType,
      sourceInterval: params.sourceInterval,
      strength,
      touches,
      pivots: pivotsCount,
      fromTs,
      toTs,
    })
  }

  candidates.sort((a, b) => b.strength - a.strength)

  const trimmed = candidates.slice(0, Math.max(1, config.maxLevels * 3))

  const filtered = filterCloseLevels(
    trimmed,
    config.minDistancePercentBetweenLevels
  )

  return filtered
    .sort((a, b) => b.strength - a.strength)
    .slice(0, config.maxLevels)
    .sort((a, b) => a.price - b.price)
}
