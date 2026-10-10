import {
  BEIJING_OFFSET_MS,
  HOLIDAY_CALENDAR,
  MODEL_PRICES,
  PEAK_WINDOWS,
  PRICING_CURRENCY,
  PRICING_VERSION,
} from '../../contracts/pricing.js';
import type { ModelPrice } from '../../contracts/pricing.js';
import type { CostMetrics, TokenMetrics } from '../../contracts/run.js';
import { isNonNegativeInteger, isRecord } from './evidence-parsers.js';
import type { NativeView } from './types.js';

interface UsageRecord {
  readonly timeMs: number | null;
  readonly model: string;
  readonly cacheHit: number;
  readonly cacheMiss: number;
  readonly output: number;
}

export interface TokenCostMetrics {
  readonly tokens: TokenMetrics | 'NOT_MEASURED';
  readonly cost: CostMetrics | 'NOT_MEASURED';
}

const NOT_MEASURED: TokenCostMetrics = { tokens: 'NOT_MEASURED', cost: 'NOT_MEASURED' };

/**
 * Sum provider usage from native assistant records and price each response by
 * the period it completed in. Any dispatched request without a matching usage
 * record leaves both figures NOT_MEASURED: a partial sum would under-report.
 * An `assistant/attempt` (failed, retried or cancelled attempt) never carries
 * usage even when the provider billed it, so its presence alone makes the sum
 * incomplete.
 */
export function measureTokenCost(
  nativeViews: readonly NativeView[],
  modelRequests: number,
  fallbackModel: string,
): TokenCostMetrics {
  const records: UsageRecord[] = [];
  let messages = 0;
  for (const view of nativeViews) {
    if (view.type === 'assistant/attempt') return NOT_MEASURED;
    if (view.type !== 'assistant/message') continue;
    messages += 1;
    const usage = parseUsage(view.data.usage);
    if (usage === null) return NOT_MEASURED;
    const message = isRecord(view.data.message) ? view.data.message : null;
    const source = message !== null && isRecord(message.source) ? message.source : null;
    const model = source !== null && typeof source.model === 'string' ? source.model : fallbackModel;
    records.push({ timeMs: view.timeMs, model, ...usage });
  }
  if (messages === 0 || messages < modelRequests) return NOT_MEASURED;

  const tokens: TokenMetrics = { input_cache_hit: 0, input_cache_miss: 0, output: 0, total: 0 };
  for (const record of records) {
    tokens.input_cache_hit += record.cacheHit;
    tokens.input_cache_miss += record.cacheMiss;
    tokens.output += record.output;
  }
  tokens.total = tokens.input_cache_hit + tokens.input_cache_miss + tokens.output;
  return { tokens, cost: priceRecords(records) };
}

function parseUsage(value: unknown): Pick<UsageRecord, 'cacheHit' | 'cacheMiss' | 'output'> | null {
  if (!isRecord(value)) return null;
  const optional = (field: unknown): number | null => field === undefined ? 0 : isNonNegativeInteger(field) ? field : null;
  const input = value.inputTokens;
  const output = value.outputTokens;
  const cacheRead = optional(value.cacheReadTokens);
  const cacheWrite = optional(value.cacheWriteTokens);
  if (!isNonNegativeInteger(input) || !isNonNegativeInteger(output) || cacheRead === null || cacheWrite === null) return null;
  // DeepSeek bills only cache hit and cache miss; written cache is a miss.
  return { cacheHit: cacheRead, cacheMiss: input + cacheWrite, output };
}

function priceRecords(records: readonly UsageRecord[]): CostMetrics | 'NOT_MEASURED' {
  let peak = 0;
  let offPeak = 0;
  let peakRequests = 0;
  let offPeakRequests = 0;
  for (const record of records) {
    const prices = MODEL_PRICES[record.model];
    if (prices === undefined || record.timeMs === null) return 'NOT_MEASURED';
    const period = pricingPeriod(record.timeMs);
    if (period === null) return 'NOT_MEASURED';
    const amount = priceUsage(period === 'peak' ? prices.peak : prices.offPeak, record);
    if (period === 'peak') {
      peak += amount;
      peakRequests += 1;
    } else {
      offPeak += amount;
      offPeakRequests += 1;
    }
  }
  return {
    currency: PRICING_CURRENCY,
    total: roundCny(peak + offPeak),
    peak: roundCny(peak),
    off_peak: roundCny(offPeak),
    peak_requests: peakRequests,
    off_peak_requests: offPeakRequests,
    pricing_version: PRICING_VERSION,
  };
}

function priceUsage(price: ModelPrice, record: UsageRecord): number {
  return (
    record.cacheHit * price.inputCacheHit +
    record.cacheMiss * price.inputCacheMiss +
    record.output * price.output
  ) / 1_000_000;
}

function roundCny(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/** Peak or off-peak for an epoch-ms instant; null when the holiday calendar has no data for that year. */
export function pricingPeriod(timeMs: number): 'peak' | 'off_peak' | null {
  const beijing = new Date(timeMs + BEIJING_OFFSET_MS);
  const holidays = HOLIDAY_CALENDAR[beijing.getUTCFullYear()];
  if (holidays === undefined) return null;
  const weekday = beijing.getUTCDay();
  if (weekday === 0 || weekday === 6) return 'off_peak';
  const date = beijing.toISOString().slice(0, 10);
  if (holidays.some(([start, end]) => date >= start && date <= end)) return 'off_peak';
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  return PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end) ? 'peak' : 'off_peak';
}
