import assert from 'node:assert/strict';
import test from 'node:test';

import { PRICING_VERSION } from '../../src/contracts/pricing.js';
import { measureTokenCost, pricingPeriod } from '../../src/eval/business/token-cost.js';
import type { NativeView } from '../../src/eval/business/types.js';

const at = (iso: string): number => Date.parse(iso);

function assistant(
  index: number,
  timeMs: number | null,
  usage: unknown,
  model = 'deepseek-flash',
  type = 'assistant/message',
): NativeView {
  return {
    index,
    type,
    timeMs,
    data: {
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model } },
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

test('pricing period follows Beijing-time weekday peak windows', () => {
  // Monday 2026-10-12, Beijing time is UTC+8.
  assert.equal(pricingPeriod(at('2026-10-12T00:59:00Z')), 'off_peak'); // 08:59
  assert.equal(pricingPeriod(at('2026-10-12T01:00:00Z')), 'peak'); // 09:00
  assert.equal(pricingPeriod(at('2026-10-12T03:59:59Z')), 'peak'); // 11:59:59
  assert.equal(pricingPeriod(at('2026-10-12T04:00:00Z')), 'off_peak'); // 12:00
  assert.equal(pricingPeriod(at('2026-10-12T05:59:00Z')), 'off_peak'); // 13:59
  assert.equal(pricingPeriod(at('2026-10-12T06:00:00Z')), 'peak'); // 14:00
  assert.equal(pricingPeriod(at('2026-10-12T09:59:00Z')), 'peak'); // 17:59
  assert.equal(pricingPeriod(at('2026-10-12T10:00:00Z')), 'off_peak'); // 18:00
  // 2026-10-12 17:00 UTC is already Tuesday 01:00 in Beijing.
  assert.equal(pricingPeriod(at('2026-10-12T17:00:00Z')), 'off_peak');
});

test('weekends, statutory holidays, and make-up workdays are off-peak', () => {
  assert.equal(pricingPeriod(at('2026-10-11T02:00:00Z')), 'off_peak'); // Sunday 10:00
  assert.equal(pricingPeriod(at('2026-10-10T02:00:00Z')), 'off_peak'); // make-up Saturday 10:00
  assert.equal(pricingPeriod(at('2026-10-05T02:00:00Z')), 'off_peak'); // National Day Monday
  assert.equal(pricingPeriod(at('2026-02-23T02:00:00Z')), 'off_peak'); // last Spring Festival day
  assert.equal(pricingPeriod(at('2026-02-24T02:00:00Z')), 'peak'); // first workday after it
  assert.equal(pricingPeriod(at('2026-10-08T01:30:00Z')), 'peak'); // Thursday 09:30 after National Day
});

test('pricing period is unknown for a year without holiday data', () => {
  assert.equal(pricingPeriod(at('2027-03-01T02:00:00Z')), null);
  assert.equal(pricingPeriod(at('2025-12-31T02:00:00Z')), null);
});

test('tokens are summed and each response is priced by its own period', () => {
  const views = [
    assistant(0, at('2026-10-12T02:00:00Z'), { inputTokens: 1000, outputTokens: 500, totalTokens: 3500, cacheReadTokens: 2000 }),
    assistant(1, at('2026-10-12T12:00:00Z'), { inputTokens: 100, outputTokens: 10, cacheWriteTokens: 50 }),
  ];
  const { tokens, cost } = measureTokenCost(views, 2, 'deepseek-flash');
  assert.deepEqual(tokens, { input_cache_hit: 2000, input_cache_miss: 1150, output: 510, total: 3660 });
  // Peak: 2000×0.04 + 1000×2 + 500×8 = 6080; off-peak: 150×1 + 10×4 = 190 (per 1M tokens).
  assert.deepEqual(cost, {
    currency: 'CNY',
    total: 0.00627,
    peak: 0.00608,
    off_peak: 0.00019,
    peak_requests: 1,
    off_peak_requests: 1,
    pricing_version: PRICING_VERSION,
  });
});

test('legacy flash names use the flash price and pro uses its own', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 0 };
  const legacy = measureTokenCost([assistant(0, at('2026-10-12T02:00:00Z'), usage, 'deepseek-v4-flash')], 1, 'x');
  const pro = measureTokenCost([assistant(0, at('2026-10-12T02:00:00Z'), usage, 'deepseek-v4-pro')], 1, 'x');
  assert.equal(legacy.cost !== 'NOT_MEASURED' && legacy.cost.total, 2);
  assert.equal(pro.cost !== 'NOT_MEASURED' && pro.cost.total, 9);
});

test('any assistant/attempt leaves tokens and cost NOT_MEASURED, even when messages cover every request', () => {
  // The attempt carries no usage, yet the provider may have billed it; a retried step
  // can still yield one message per counted request, so the count check alone is not enough.
  const views = [
    assistant(0, at('2026-10-11T02:00:00Z'), undefined, 'deepseek-flash', 'assistant/attempt'),
    assistant(1, at('2026-10-11T02:00:02Z'), { inputTokens: 20, outputTokens: 5 }),
  ];
  assert.deepEqual(measureTokenCost(views, 1, 'deepseek-flash'), { tokens: 'NOT_MEASURED', cost: 'NOT_MEASURED' });
});

test('incomplete usage evidence is NOT_MEASURED instead of a partial sum', () => {
  const ok = { inputTokens: 1, outputTokens: 1 };
  const time = at('2026-10-12T02:00:00Z');
  const notMeasured = { tokens: 'NOT_MEASURED', cost: 'NOT_MEASURED' };
  assert.deepEqual(measureTokenCost([], 0, 'deepseek-flash'), notMeasured);
  assert.deepEqual(measureTokenCost([assistant(0, time, ok)], 2, 'deepseek-flash'), notMeasured);
  assert.deepEqual(measureTokenCost([assistant(0, time, ok), assistant(1, time, undefined)], 2, 'deepseek-flash'), notMeasured);
  assert.deepEqual(measureTokenCost([assistant(0, time, { inputTokens: -1, outputTokens: 1 })], 1, 'deepseek-flash'), notMeasured);
  assert.deepEqual(measureTokenCost([assistant(0, time, { inputTokens: 1.5, outputTokens: 1 })], 1, 'deepseek-flash'), notMeasured);
});

test('tokens stay measured when cost cannot be priced', () => {
  const usage = { inputTokens: 1, outputTokens: 1 };
  const unknownModel = measureTokenCost([assistant(0, at('2026-10-12T02:00:00Z'), usage, 'other-model')], 1, 'deepseek-flash');
  const noCalendar = measureTokenCost([assistant(0, at('2027-03-01T02:00:00Z'), usage)], 1, 'deepseek-flash');
  const noTime = measureTokenCost([assistant(0, null, usage)], 1, 'deepseek-flash');
  for (const result of [unknownModel, noCalendar, noTime]) {
    assert.notEqual(result.tokens, 'NOT_MEASURED');
    assert.equal(result.cost, 'NOT_MEASURED');
  }
});
