import type { Pivot } from "./pivots"

export type Cluster = {
  prices: number[]
  indices: number[]
  pivotTypes: ("high" | "low")[]
}

export function priceTolerance(price: number, percent: number): number {
  return Math.abs(price) * (percent / 100)
}

export function median(values: number[]): number {
  if (values.length === 0) return 0

  const arr = [...values].sort((a, b) => a - b)
  const mid = Math.floor(arr.length / 2)

  return arr.length % 2
    ? arr[mid]
    : (arr[mid - 1] + arr[mid]) / 2
}

/**
 * Cluster pivot prices using percentage tolerance
 */
export function clusterPivotsByPrice(
  pivots: Pivot[],
  tolerancePercent: number
): Cluster[] {

  if (pivots.length === 0) return []

  const sorted = [...pivots].sort((a, b) => a.price - b.price)

  const clusters: Cluster[] = []

  let current: Cluster = {
    prices: [sorted[0].price],
    indices: [sorted[0].index],
    pivotTypes: [sorted[0].type]
  }

  for (let i = 1; i < sorted.length; i++) {

    const pv = sorted[i]

    const center = median(current.prices)

    const tol = priceTolerance(center, tolerancePercent)

    if (Math.abs(pv.price - center) <= tol) {

      current.prices.push(pv.price)
      current.indices.push(pv.index)
      current.pivotTypes.push(pv.type)

    } else {

      clusters.push(current)

      current = {
        prices: [pv.price],
        indices: [pv.index],
        pivotTypes: [pv.type]
      }
    }
  }

  clusters.push(current)

  return clusters
}
