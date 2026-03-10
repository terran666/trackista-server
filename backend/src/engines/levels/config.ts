import type { LevelsConfig } from "./types"

export const DEFAULT_LEVELS_CONFIG: LevelsConfig = {

  pivotLeft: 5,
  pivotRight: 5,

  toleranceMode: "percent",
  tolerancePercent: 0.25,

  minPivotsInCluster: 2,
  minTouches: 2,

  maxLevels: 10,
  minDistancePercentBetweenLevels: 0.15,

  wPivots: 2,
  wTouches: 1,
  wSpan: 1
}

export function mergeConfig(
  partial?: Partial<LevelsConfig>
): LevelsConfig {

  return {
    ...DEFAULT_LEVELS_CONFIG,
    ...(partial ?? {})
  }
}
