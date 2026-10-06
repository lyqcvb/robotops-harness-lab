import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_BUDGETS,
  DEFAULT_MODEL,
  HARNESS_VERSION,
  TOOL_NAMES,
} from '../../src/contracts/probe-constants.js';

test('pins the Harness version and default model', () => {
  assert.equal(HARNESS_VERSION, '0.1.5-rc.3');
  assert.equal(DEFAULT_MODEL, 'deepseek-flash');
});

test('defines seven unique whitelisted tool names', () => {
  assert.equal(TOOL_NAMES.length, 7);
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
});

test('defines the Stage 0 default budgets', () => {
  assert.deepEqual(DEFAULT_BUDGETS, {
    modelRequests: 20,
    toolCalls: 30,
    activeMs: 300000,
    approvalMs: 120000,
  });
});

