import { calculateLevels } from "../engines/levels/levelsCalculator"
import type { Bar } from "../shared/types"

const bars: Bar[] = [
  { time: 1, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { time: 2, open: 102, high: 103, low: 101, close: 102, volume: 12 },
  { time: 3, open: 105, high: 106, low: 104, close: 105, volume: 15 },
  { time: 4, open: 102, high: 103, low: 101, close: 102, volume: 11 },
  { time: 5, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { time: 6, open: 98, high: 99, low: 97, close: 98, volume: 14 },
  { time: 7, open: 96, high: 97, low: 95, close: 96, volume: 16 },
  { time: 8, open: 98, high: 99, low: 97, close: 98, volume: 13 },
  { time: 9, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { time: 10, open: 103, high: 104, low: 102, close: 103, volume: 12 },
  { time: 11, open: 106, high: 107, low: 105, close: 106, volume: 18 },
  { time: 12, open: 103, high: 104, low: 102, close: 103, volume: 11 },
  { time: 13, open: 100, high: 101, low: 99, close: 100, volume: 10 },
]

const levels = calculateLevels({
  bars,
  levelType: "resistance",
  sourceInterval: "1m",
  config: {
    pivotLeft: 2,
    pivotRight: 2,
    minPivotsInCluster: 1,
    minTouches: 1,
    maxLevels: 5,
  },
})

console.log(JSON.stringify(levels, null, 2))