import type { Bar } from "../../shared/types"

export type Interval = string

export type LevelType =
  | "support"
  | "resistance"
  | "global"
  | "local"

export type Level = {
  price: number
  type: LevelType
  sourceInterval: Interval

  strength: number
  touches: number
  pivots: number

  fromTs: number
  toTs: number
}

export type LevelsConfig = {
  pivotLeft: number
  pivotRight: number

  toleranceMode: "percent"
  tolerancePercent: number

  minPivotsInCluster: number
  minTouches: number

  maxLevels: number
  minDistancePercentBetweenLevels: number

  wPivots: number
  wTouches: number
  wSpan: number
}

export type CalculateLevelsParams = {
  bars: Bar[]

  levelType: LevelType
  sourceInterval: Interval

  config?: Partial<LevelsConfig>
}
