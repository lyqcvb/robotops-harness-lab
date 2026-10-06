import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_FAILURES,
  DEFAULT_FIXTURE,
  ROBOT_STATES,
  TASK_STATES,
  TOOL_NAMES,
} from '../../src/contracts/business.js';
import { BusinessTrace } from '../../src/trace/business-trace.js';

test('defines the Stage 1 business contract constants and default fixture', () => {
  assert.deepEqual(ROBOT_STATES, [
    'IDLE',
    'MOVING',
    'ERROR',
    'REBOOTING',
    'CHARGING',
    'OFFLINE',
  ]);
  assert.deepEqual(TASK_STATES, [
    'PENDING',
    'RUNNING',
    'PAUSED',
    'FAILED',
    'COMPLETED',
  ]);
  assert.deepEqual(TOOL_NAMES, [
    'get_robot_status',
    'get_task_status',
    'search_sop',
    'restart_navigation',
    'force_reboot',
    'resume_task',
    'create_maintenance_ticket',
  ]);
  assert.deepEqual(DEFAULT_FIXTURE, {
    robots: [
      {
        robot_id: 'R-03',
        state: 'ERROR',
        battery: 31,
        error_code: 'NAV_042',
        current_task: 'TASK-502',
      },
    ],
    tasks: [{ task_id: 'TASK-502', robot_id: 'R-03', status: 'PAUSED' }],
  });
  assert.deepEqual(DEFAULT_FAILURES, {
    restart_navigation: ['TIMEOUT', 'TIMEOUT'],
    force_reboot: ['SUCCESS'],
  });
});

test('defensively clones recorded input and returned events', () => {
  const trace = new BusinessTrace({ runId: 'run-clone' });
  const source = {
    nested: { count: 1 },
    list: [{ label: 'original' }],
  };

  const recorded = trace.record('tool_result', 'call-1', source);
  source.nested.count = 99;
  source.list[0]!.label = 'mutated-input';

  const returnedData = recorded.data as {
    nested: { count: number };
    list: Array<{ label: string }>;
  };
  assert.deepEqual(returnedData, {
    nested: { count: 1 },
    list: [{ label: 'original' }],
  });

  returnedData.nested.count = 42;
  returnedData.list[0]!.label = 'mutated-return';
  assert.deepEqual(trace.events()[0]?.data, {
    nested: { count: 1 },
    list: [{ label: 'original' }],
  });

  const firstRead = trace.events();
  const secondRead = trace.events();
  assert.notStrictEqual(firstRead[0], secondRead[0]);
  assert.notStrictEqual(firstRead[0]?.data, secondRead[0]?.data);
  firstRead[0]!.data.added = true;
  assert.deepEqual(secondRead[0]?.data, {
    nested: { count: 1 },
    list: [{ label: 'original' }],
  });
});

test('assigns contiguous sequence numbers and preserves call associations', () => {
  const trace = new BusinessTrace({ runId: 'run-sequence' });

  const first = trace.record('first', 'call-1', {});
  const second = trace.record('second', null, {});
  const third = trace.record('third', 'call-3', {});

  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(third.seq, 3);
  assert.deepEqual(
    trace.events().map((event) => event.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    trace.events().map((event) => event.call_id),
    ['call-1', null, 'call-3'],
  );
});

test('uses unit defaults and keeps pure unit events unbound from a session', () => {
  const trace = new BusinessTrace({ runId: 'run-unit' });

  assert.equal(trace.runId, 'run-unit');
  assert.equal(trace.scenarioId, 'unit');
  assert.equal(trace.sessionId, null);

  const event = trace.record('unit_event', 'call-1', {});
  assert.equal(event.session_id, null);
  assert.equal(trace.events()[0]?.session_id, null);
});

test('binds a real session id to all existing and future events', () => {
  const trace = new BusinessTrace({ runId: 'run-session' });
  trace.record('before_bind', 'call-1', {});
  trace.setSessionId('session-real-1');
  trace.setSessionId('session-real-1');
  trace.record('after_bind', 'call-2', {});

  assert.equal(trace.sessionId, 'session-real-1');
  assert.deepEqual(
    trace.events().map((event) => event.session_id),
    ['session-real-1', 'session-real-1'],
  );
});

test('rejects changing to a different session id', () => {
  const trace = new BusinessTrace({ runId: 'run-session-conflict' });
  trace.setSessionId('session-real-1');

  assert.throws(
    () => trace.setSessionId('session-real-2'),
    /Cannot change sessionId/,
  );
  assert.equal(trace.sessionId, 'session-real-1');
});

test('uses the injected clock without advancing timestamps implicitly', () => {
  const timestamps = [12.5, 40, 41.25];
  const trace = new BusinessTrace({
    runId: 'run-clock',
    now: () => timestamps.shift()!,
  });

  assert.equal(trace.record('one', null, {}).at_ms, 12.5);
  assert.equal(trace.record('two', null, {}).at_ms, 40);
  assert.equal(trace.record('three', null, {}).at_ms, 41.25);
  assert.deepEqual(
    trace.events().map((event) => event.at_ms),
    [12.5, 40, 41.25],
  );
});

test('rejects naked Error values that are not JSON-compatible', () => {
  const trace = new BusinessTrace({ runId: 'run-json' });

  assert.throws(
    () => trace.record('bad_data', null, { error: new Error('boom') }),
    /plain JSON objects/,
  );
  assert.deepEqual(trace.events(), []);
});

