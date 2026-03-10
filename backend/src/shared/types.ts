export type Bar = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type LevelType = "support" | "resistance"

export type Level = {
  symbol: string
  timeframe: string
  price: number
  type: LevelType
  touches: number
  strength: number
  createdAt: number
}

export type Pivot = {
  index: number
  price: number
  type: "high" | "low"
}
