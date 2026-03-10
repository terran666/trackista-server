import { Bar } from "../../shared/types"

export type PivotType = "high" | "low"

export type Pivot = {
  index: number
  price: number
  type: PivotType
}

/**
 * Find pivot highs/lows from price array
 */
export function findPivots(
  prices: number[],
  left: number,
  right: number
): Pivot[] {
  const n = prices.length
  if (n === 0) return []

  const pivots: Pivot[] = []

  for (let i = left; i < n - right; i++) {
    const p = prices[i]

    let isHigh = true
    let isLow = true

    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue

      const pj = prices[j]

      if (p <= pj) isHigh = false
      if (p >= pj) isLow = false

      if (!isHigh && !isLow) break
    }

    if (isHigh) pivots.push({ index: i, price: p, type: "high" })
    else if (isLow) pivots.push({ index: i, price: p, type: "low" })
  }

  return pivots
}

/**
 * Helper: extract pivot highs from bars
 */
export function findHighPivots(
  bars: Bar[],
  left: number,
  right: number
): Pivot[] {
  const highs = bars.map(b => b.high)
  return findPivots(highs, left, right)
}

/**
 * Helper: extract pivot lows from bars
 */
export function findLowPivots(
  bars: Bar[],
  left: number,
  right: number
): Pivot[] {
  const lows = bars.map(b => b.low)
  return findPivots(lows, left, right)
}
