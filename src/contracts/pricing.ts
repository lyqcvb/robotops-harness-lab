/**
 * DeepSeek official API pricing (CNY per 1M tokens), peak/off-peak scheme.
 * Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing, read 2026-10-10.
 *
 * Peak: Monday–Friday 09:00–12:00 and 14:00–18:00 Beijing time, excluding
 * Chinese statutory holidays. Every other moment, weekends and holidays
 * included, is off-peak at half the peak price. Weekend make-up workdays
 * (调休) stay off-peak because the rule names Monday–Friday only.
 */
export const PRICING_VERSION = 'deepseek-official-2026-10-10' as const;
export const PRICING_CURRENCY = 'CNY' as const;

export interface ModelPrice {
  readonly inputCacheHit: number;
  readonly inputCacheMiss: number;
  readonly output: number;
}

export interface PeakOffPeakPrice {
  readonly peak: ModelPrice;
  readonly offPeak: ModelPrice;
}

const FLASH_PRICE: PeakOffPeakPrice = Object.freeze({
  peak: Object.freeze({ inputCacheHit: 0.04, inputCacheMiss: 2, output: 8 }),
  offPeak: Object.freeze({ inputCacheHit: 0.02, inputCacheMiss: 1, output: 4 }),
});

const V4_PRO_PRICE: PeakOffPeakPrice = Object.freeze({
  peak: Object.freeze({ inputCacheHit: 0.3, inputCacheMiss: 9, output: 27 }),
  offPeak: Object.freeze({ inputCacheHit: 0.15, inputCacheMiss: 4.5, output: 13.5 }),
});

/** Legacy flash names are served by DeepSeek-V4.1-Flash and billed at the flash price. */
export const MODEL_PRICES: Readonly<Record<string, PeakOffPeakPrice>> = Object.freeze({
  'deepseek-flash': FLASH_PRICE,
  'deepseek-v4-flash': FLASH_PRICE,
  'deepseek-v4-flash-vision-exp': FLASH_PRICE,
  'deepseek-v4-pro': V4_PRO_PRICE,
});

/** Beijing time is UTC+8 with no daylight saving. */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Peak windows as [start, end) minutes since Beijing midnight. */
export const PEAK_WINDOWS: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([9 * 60, 12 * 60] as const),
  Object.freeze([14 * 60, 18 * 60] as const),
]);

/**
 * Statutory holiday closures as inclusive Beijing-date ranges, from the State
 * Council notice on the 2026 holiday arrangement (国务院办公厅关于2026年部分
 * 节假日安排的通知, 2025-11-04). A year missing here cannot be priced, so its runs report cost
 * as NOT_MEASURED rather than guessing.
 */
export const HOLIDAY_CALENDAR: Readonly<Record<number, readonly (readonly [string, string])[]>> = Object.freeze({
  2026: Object.freeze([
    Object.freeze(['2026-01-01', '2026-01-03'] as const),
    Object.freeze(['2026-02-15', '2026-02-23'] as const),
    Object.freeze(['2026-04-04', '2026-04-06'] as const),
    Object.freeze(['2026-05-01', '2026-05-05'] as const),
    Object.freeze(['2026-06-19', '2026-06-21'] as const),
    Object.freeze(['2026-09-25', '2026-09-27'] as const),
    Object.freeze(['2026-10-01', '2026-10-07'] as const),
  ]),
});
