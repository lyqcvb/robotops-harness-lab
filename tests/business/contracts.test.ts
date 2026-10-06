import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_NAMES as BUSINESS_TOOL_NAMES } from '../../src/contracts/business.js';
import { canonicalJson } from '../../src/contracts/canonical-json.js';
import {
  ACTION_LIMITS,
  DEFAULT_BUDGETS,
  DEFAULT_MODEL,
  HARNESS_VERSION,
  SOFT_STOP_REASONS,
  isSoftStopReason,
} from '../../src/contracts/policy.js';
import {
  DEFAULT_BUDGETS as STAGE0_DEFAULT_BUDGETS,
  DEFAULT_MODEL as STAGE0_DEFAULT_MODEL,
  HARNESS_VERSION as STAGE0_HARNESS_VERSION,
  TOOL_NAMES as STAGE0_TOOL_NAMES,
} from '../../src/contracts/probe-constants.js';
import {
  RESULT_STATUSES,
  TOOL_NAMES,
  TOOL_PARAMETERS,
  TOOL_PARAMETER_SCHEMAS,
  TOOL_OUTPUT_SCHEMA,
} from '../../src/contracts/tool-protocol.js';
import {
  canonicalize,
  TOOL_PARAMETERS as BOUNDARY_TOOL_PARAMETERS,
} from '../../src/tools/tool-boundary.js';

test('publishes frozen shared policy constants with Stage 0 compatibility exports', () => {
  assert.equal(HARNESS_VERSION, '0.1.5-rc.3');
  assert.equal(DEFAULT_MODEL, 'deepseek-flash');
  assert.deepEqual(DEFAULT_BUDGETS, {
    modelRequests: 20,
    toolCalls: 30,
    activeMs: 300_000,
    approvalMs: 120_000,
  });
  assert.deepEqual(ACTION_LIMITS, {
    restart_navigation: 2,
    force_reboot: 1,
  });
  assert.deepEqual(SOFT_STOP_REASONS, [
    'FAIL_FAST',
    'SOP_NOT_FOUND',
    'APPROVAL_REJECTED',
    'APPROVAL_REQUIRED',
    'APPROVAL_UNAVAILABLE',
  ]);

  assert.equal(Object.isFrozen(DEFAULT_BUDGETS), true);
  assert.equal(Object.isFrozen(ACTION_LIMITS), true);
  assert.equal(Object.isFrozen(SOFT_STOP_REASONS), true);
  for (const reason of SOFT_STOP_REASONS) assert.equal(isSoftStopReason(reason), true);
  assert.equal(isSoftStopReason(null), false);
  assert.equal(isSoftStopReason('BUDGET_EXHAUSTED'), false);

  assert.equal(STAGE0_HARNESS_VERSION, HARNESS_VERSION);
  assert.equal(STAGE0_DEFAULT_MODEL, DEFAULT_MODEL);
  assert.equal(STAGE0_DEFAULT_BUDGETS, DEFAULT_BUDGETS);
  assert.equal(STAGE0_TOOL_NAMES, TOOL_NAMES);
});

test('defines the seven-tool protocol once and preserves legacy business/tool exports', () => {
  assert.deepEqual(TOOL_NAMES, [
    'get_robot_status',
    'get_task_status',
    'search_sop',
    'restart_navigation',
    'force_reboot',
    'resume_task',
    'create_maintenance_ticket',
  ]);
  assert.deepEqual(RESULT_STATUSES, [
    'SUCCESS',
    'RETRYABLE_FAILURE',
    'FATAL_FAILURE',
    'DENIED',
  ]);
  assert.deepEqual(TOOL_PARAMETERS, {
    get_robot_status: ['robot_id'],
    get_task_status: ['task_id'],
    search_sop: ['error_code'],
    restart_navigation: ['robot_id'],
    force_reboot: ['robot_id'],
    resume_task: ['robot_id', 'task_id'],
    create_maintenance_ticket: ['robot_id', 'reason'],
  });
  assert.deepEqual(TOOL_PARAMETER_SCHEMAS, {
    get_robot_status: { robot_id: { type: 'string', required: true } },
    get_task_status: { task_id: { type: 'string', required: true } },
    search_sop: { error_code: { type: 'string', required: true } },
    restart_navigation: { robot_id: { type: 'string', required: true } },
    force_reboot: { robot_id: { type: 'string', required: true } },
    resume_task: {
      robot_id: { type: 'string', required: true },
      task_id: { type: 'string', required: true },
    },
    create_maintenance_ticket: {
      robot_id: { type: 'string', required: true },
      reason: { type: 'string', required: true },
    },
  });
  assert.deepEqual(TOOL_OUTPUT_SCHEMA, {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: {
        type: 'string',
        enum: ['SUCCESS', 'RETRYABLE_FAILURE', 'FATAL_FAILURE', 'DENIED'],
        required: true,
      },
      error_code: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        required: true,
      },
      reason: { type: 'string', required: true },
      data: { type: 'json', required: true },
    },
  });

  assert.equal(BUSINESS_TOOL_NAMES, TOOL_NAMES);
  assert.equal(BOUNDARY_TOOL_PARAMETERS, TOOL_PARAMETERS);
});

test('canonical JSON is deterministic and rejects non-JSON values', () => {
  const ordered = canonicalJson({
    z: 1,
    nested: { b: 2, a: 1 },
    list: [{ y: 2, x: 1 }],
  });
  assert.equal(ordered, '{"list":[{"x":1,"y":2}],"nested":{"a":1,"b":2},"z":1}');
  assert.equal(canonicalize({ z: 1, nested: { b: 2, a: 1 } }), canonicalJson({
    nested: { a: 1, b: 2 },
    z: 1,
  }));

  assert.throws(() => canonicalJson({ invalid: undefined }), /canonicalize/);
  assert.throws(() => canonicalJson({ invalid: Number.NaN }), /finite JSON numbers/);
  assert.throws(() => canonicalJson({ invalid: Number.POSITIVE_INFINITY }), /finite JSON numbers/);
  assert.throws(() => canonicalJson({ [Symbol('invalid')]: 1 }), /symbol keys/);
  assert.throws(() => canonicalJson(new Date(0)), /plain JSON objects/);

  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(() => canonicalJson(circular), /circular references/);
});
