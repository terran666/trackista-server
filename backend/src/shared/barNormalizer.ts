import { Bar } from "./types"

type RawBarArray = [number, number, number, number, number, number]

function isRawBarArray(input: unknown): input is RawBarArray {
  return Array.isArray(input) && input.length >= 6 && input.every((v) => typeof v === "number")
}

export function normalizeBars(input: any[]): Bar[] {
  return input.map((item) => {
    if (isRawBarArray(item)) {
      const [time, open, high, low, close, volume] = item
      return { time, open, high, low, close, volume }
    }

    return {
      time: Number(item.time ?? item.openTime ?? item.t),
      open: Number(item.open ?? item.o),
      high: Number(item.high ?? item.h),
      low: Number(item.low ?? item.l),
      close: Number(item.close ?? item.c),
      volume: Number(item.volume ?? item.v ?? 0),
    }
  })
}
