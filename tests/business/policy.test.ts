import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_FIXTURE,
  type ExecutionContext,
  type FailureSequences,
  type SimulatorFixture,
  type ToolName,
} from '../../src/contracts/business.js';
import { BusinessServices, type ServicePort } from '../../src/services/business-services.js';
import { RobotSimulator } from '../../src/simulator/robot-simulator.js';
import { ApprovalLedger } from '../../src/tools/approval-ledger.js';
import {
  canonicalize,
  ToolBoundary,
  TOOL_PARAMETERS,
} from '../../src/tools/tool-boundary.js';
import { BusinessTrace } from '../../src/trace/business-trace.js';

interface HarnessOptions {
  readonly budgets?: Partial<{
    modelRequests: number;
    toolCalls: number;
    activeMs: number;
    approvalMs: number;
  }>;
  readonly now?: () => number;
  readonly recoveryMode?: 'full' | 'fail-fast';
  readonly authorizeForce?: (
    ctx: ExecutionContext,
    args: Record<string, string>,
    fingerprint: string,
  ) => boolean;
  readonly fixture?: SimulatorFixture;
  readonly failures?: Partial<FailureSequences>;
}

function createHarness(options: HarnessOptions = {}) {
  const runId = 'run-policy';
  const sessionId = 'session-policy';
  const now = options.now ?? (() => 0);
  const trace = new BusinessTrace({ runId, sessionId, now });
  const simulator = new RobotSimulator({
    runId,
    trace,
    fixture: options.fixture,
    failures: options.failures,
  });
  const services = new BusinessServices({ runId, simulator, trace });
  const boundary = new ToolBoundary({
    runId,
    trace,
    services,
    budgets: options.budgets,
    now,
    recoveryMode: options.recoveryMode,
    authorizeForce: options.authorizeForce,
  });
  const context = (callId: string, signal?: AbortSignal): ExecutionContext => ({
    run_id: runId,
    session_id: sessionId,
    call_id: callId,
    signal,
  });
  return { runId, sessionId, trace, simulator, services, boundary, context };
}

function eventsOfType(trace: BusinessTrace, type: string) {
  return trace.events().filter((event) => event.type === type);
}

const IDLE_PAUSED_FIXTURE: SimulatorFixture = {
  robots: [
    {
      robot_id: 'R-03',
      state: 'IDLE',
      battery: 31,
      error_code: null,
      current_task: 'TASK-502',
    },
  ],
  tasks: [
    {
      task_id: 'TASK-502',
      robot_id: 'R-03',
      status: 'PAUSED',
    },
  ],
};

test('publishes the seven parameter schemas and canonicalizes recursively', () => {
  assert.deepEqual(TOOL_PARAMETERS, {
    get_robot_status: ['robot_id'],
    get_task_status: ['task_id'],
    search_sop: ['error_code'],
    restart_navigation: ['robot_id'],
    force_reboot: ['robot_id'],
    resume_task: ['robot_id', 'task_id'],
    create_maintenance_ticket: ['robot_id', 'reason'],
  });
  assert.equal(
    canonicalize({ z: 1, nested: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }] }),
    '{"list":[{"x":1,"y":2}],"nested":{"a":1,"b":2},"z":1}',
  );
  assert.throws(() => canonicalize({ invalid: undefined }), /canonicalize/);
});

test('rejects unknown tools and strict schema violations with uniform codes', async () => {
  const harness = createHarness();

  const unknown = await harness.boundary.invoke(
    'shell',
    {},
    harness.context('call-unknown'),
  );
  const missing = await harness.boundary.invoke(
    'force_reboot',
    {},
    harness.context('call-missing'),
  );
  const extra = await harness.boundary.invoke(
    'force_reboot',
    { robot_id: 'R-03', approved: 'true' },
    harness.context('call-extra'),
  );
  const wrongType = await harness.boundary.invoke(
    'get_robot_status',
    { robot_id: 3 },
    harness.context('call-type'),
  );

  assert.equal(unknown.status, 'DENIED');
  assert.equal(unknown.error_code, 'UNKNOWN_TOOL');
  assert.equal(missing.status, 'DENIED');
  assert.equal(missing.error_code, 'INVALID_ARGUMENTS');
  assert.equal(extra.status, 'DENIED');
  assert.equal(extra.error_code, 'INVALID_ARGUMENTS');
  assert.equal(wrongType.status, 'DENIED');
  assert.equal(wrongType.error_code, 'INVALID_ARGUMENTS');
  assert.deepEqual(harness.simulator.snapshot().counters, {
    restart_navigation: 0,
    force_reboot: 0,
    resume_task: 0,
  });
  assert.equal(harness.boundary.stats().tool_requests, 4);
  assert.equal(eventsOfType(harness.trace, 'tool_requested').length, 4);
  assert.equal(eventsOfType(harness.trace, 'handler_started').length, 0);
});

for (const [label, jsonValue] of [
  ['object', '{"injected":true}'],
  ['string', '"hidden"'],
  ['null', 'null'],
] as const) {
  test('audits and rejects a JSON __proto__ ' + label + ' argument without throwing', async () => {
    const harness = createHarness();
    const args: unknown = JSON.parse('{"robot_id":"R-03","__proto__":' + jsonValue + '}');
    const ctx = harness.context('call-proto-' + label);

    await assert.doesNotReject(async () => {
      const result = await harness.boundary.invoke('force_reboot', args, ctx);
      assert.equal(result.status, 'DENIED');
      assert.equal(result.error_code, 'INVALID_ARGUMENTS');

      const requests = eventsOfType(harness.trace, 'tool_requested');
      assert.equal(requests.length, 1);
      const request = requests[0];
      assert.ok(request);
      assert.equal(request.call_id, ctx.call_id);
      assert.deepEqual(request.data, {
        tool_name: 'force_reboot',
        args,
        request_count: 1,
      });
      assert.equal(Object.getPrototypeOf(request.data.args), Object.prototype);
      assert.equal(Object.hasOwn(request.data.args as object, '__proto__'), true);

      const results = eventsOfType(harness.trace, 'tool_result');
      assert.equal(results.length, 1);
      assert.equal(results[0]?.call_id, ctx.call_id);
      assert.deepEqual(results[0]?.data, { tool_name: 'force_reboot', result });
    });

    assert.equal(harness.boundary.stats().tool_requests, 1);
    assert.equal(eventsOfType(harness.trace, 'handler_started').length, 0);
    assert.equal(eventsOfType(harness.trace, 'service_called').length, 0);
    assert.deepEqual(harness.simulator.snapshot().counters, {
      restart_navigation: 0,
      force_reboot: 0,
      resume_task: 0,
    });
  });
}

test('rejects whitespace-only strings before Service without rewriting arguments', async () => {
  const harness = createHarness();

  const whitespaceRobot = await harness.boundary.invoke(
    'get_robot_status',
    { robot_id: '   ' },
    harness.context('call-whitespace-robot'),
  );
  const whitespaceReason = await harness.boundary.invoke(
    'create_maintenance_ticket',
    { robot_id: 'R-03', reason: '\t\n' },
    harness.context('call-whitespace-reason'),
  );

  assert.equal(whitespaceRobot.status, 'DENIED');
  assert.equal(whitespaceRobot.error_code, 'INVALID_ARGUMENTS');
  assert.equal(whitespaceReason.status, 'DENIED');
  assert.equal(whitespaceReason.error_code, 'INVALID_ARGUMENTS');
  assert.equal(harness.boundary.stats().tool_requests, 2);
  assert.equal(eventsOfType(harness.trace, 'handler_started').length, 0);
  assert.equal(eventsOfType(harness.trace, 'service_called').length, 0);
  assert.deepEqual(
    eventsOfType(harness.trace, 'tool_requested').map((event) => event.data.args),
    [
      { robot_id: '   ' },
      { robot_id: 'R-03', reason: '\t\n' },
    ],
  );
  assert.deepEqual(harness.simulator.snapshot().counters, {
    restart_navigation: 0,
    force_reboot: 0,
    resume_task: 0,
  });
});
test('preflight validates without counting or claiming the call', () => {
  const harness = createHarness();
  const result = harness.boundary.preflight(
    'get_robot_status',
    { robot_id: 'R-03' },
    harness.context('call-preflight'),
  );

  assert.equal(result, null);
  assert.equal(harness.boundary.stats().tool_requests, 0);
  assert.equal(eventsOfType(harness.trace, 'tool_requested').length, 0);
  assert.equal(eventsOfType(harness.trace, 'service_called').length, 0);
});

test('counts invalid requests against the tool budget and stops fail-closed', async () => {
  const harness = createHarness({ budgets: { toolCalls: 1 } });

  const invalid = await harness.boundary.invoke(
    'force_reboot',
    {},
    harness.context('call-invalid-budget'),
  );
  const validButDenied = await harness.boundary.invoke(
    'get_robot_status',
    { robot_id: 'R-03' },
    harness.context('call-after-budget'),
  );

  assert.equal(invalid.error_code, 'INVALID_ARGUMENTS');
  assert.equal(validButDenied.status, 'DENIED');
  assert.equal(validButDenied.error_code, 'BUDGET_EXHAUSTED');
  assert.equal(harness.boundary.stats().tool_requests, 2);
  assert.equal(harness.boundary.stats().stopped, true);
  assert.equal(eventsOfType(harness.trace, 'service_called').length, 0);
});

test('rejects NaN, Infinity and fractional count budgets while accepting zero', () => {
  assert.throws(
    () => createHarness({ budgets: { toolCalls: Number.NaN } }),
    /finite non-negative number/,
  );
  assert.throws(
    () => createHarness({ budgets: { modelRequests: Number.POSITIVE_INFINITY } }),
    /finite non-negative number/,
  );
  assert.throws(
    () => createHarness({ budgets: { toolCalls: 0.5 } }),
    /non-negative integer/,
  );

  const zeroHarness = createHarness({ budgets: { toolCalls: 0 } });
  assert.equal(
    zeroHarness.boundary.preflight(
      'get_robot_status',
      { robot_id: 'R-03' },
      zeroHarness.context('call-zero-preflight'),
    ),
    null,
  );
});
test('model budget counts only admitted dispatches and records exhaustion', () => {
  const harness = createHarness({ budgets: { modelRequests: 1 } });

  assert.equal(harness.boundary.noteModelRequest(), true);
  assert.equal(harness.boundary.noteModelRequest(), false);

  const events = harness.trace.events();
  const dispatches = events.filter((event) => event.type === 'model_request');
  const exhausted = events.filter((event) => event.type === 'budget_exhausted');
  assert.deepEqual(dispatches.map((event) => event.data), [
    { count: 1, dispatched: true },
  ]);
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0]?.data.resource, 'model_requests');
  assert.equal(harness.boundary.stats().model_requests, 1);
});

test('enforces trusted run/session/call identity and rejects call replay', async () => {
  const harness = createHarness({ authorizeForce: () => true });

  const mismatched = await harness.boundary.invoke(
    'get_robot_status',
    { robot_id: 'R-03' },
    { ...harness.context('call-wrong-run'), run_id: 'run-other' },
  );
  const first = await harness.boundary.invoke(
    'restart_navigation',
    { robot_id: 'R-03' },
    harness.context('call-once'),
  );
  const replay = await harness.boundary.invoke(
    'restart_navigation',
    { robot_id: 'R-03' },
    harness.context('call-once'),
  );

  assert.equal(mismatched.status, 'DENIED');
  assert.equal(mismatched.error_code, 'CONTEXT_MISMATCH');
  assert.equal(first.status, 'RETRYABLE_FAILURE');
  assert.equal(replay.status, 'DENIED');
  assert.equal(replay.error_code, 'CALL_REPLAY');
  assert.equal(harness.simulator.snapshot().counters.restart_navigation, 1);
});

test('serializes different concurrent calls and executes only the first', async () => {
  const harness = createHarness({ authorizeForce: () => true });
  let entered = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayedServices: ServicePort = {
    invoke(name: ToolName, args: Record<string, string>, ctx: ExecutionContext) {
      entered += 1;
      return gate.then(() => harness.services.invoke(name, args, ctx));
    },
    snapshot() {
      return harness.services.snapshot();
    },
  };
  const boundary = new ToolBoundary({
    runId: harness.runId,
    trace: harness.trace,
    services: delayedServices,
    now: () => 0,
    authorizeForce: () => true,
  });

  const first = boundary.invoke(
    'restart_navigation',
    { robot_id: 'R-03' },
    harness.context('call-concurrent-1'),
  );
  const second = await boundary.invoke(
    'restart_navigation',
    { robot_id: 'R-03' },
    harness.context('call-concurrent-2'),
  );
  release();
  const firstResult = await first;

  assert.equal(entered, 1);
  assert.equal(firstResult.status, 'RETRYABLE_FAILURE');
  assert.equal(second.status, 'DENIED');
  assert.equal(second.error_code, 'CONCURRENT_CALL');
  assert.equal(harness.simulator.snapshot().counters.restart_navigation, 1);
});

test('default-denies force_reboot without an exact host authorizer', async () => {
  const harness = createHarness();

  const result = await harness.boundary.invoke(
    'force_reboot',
    { robot_id: 'R-03' },
    harness.context('call-default-deny'),
  );

  assert.equal(result.status, 'DENIED');
  assert.equal(result.error_code, 'APPROVAL_REQUIRED');
  assert.equal(harness.simulator.snapshot().counters.force_reboot, 0);
  assert.equal(eventsOfType(harness.trace, 'handler_started').length, 0);
  assert.equal(harness.boundary.stats().stop_reason, 'APPROVAL_REQUIRED');
});

test('leaves invalid output after a real action unreplayed and not rolled back', async () => {
  const harness = createHarness({ authorizeForce: () => true });
  const invalidServices: ServicePort = {
    invoke(name: ToolName, args: Record<string, string>, ctx: ExecutionContext) {
      const result = harness.services.invoke(name, args, ctx);
      return { ...result, extra: true };
    },
    snapshot() {
      return harness.services.snapshot();
    },
  };
  const boundary = new ToolBoundary({
    runId: harness.runId,
    trace: harness.trace,
    services: invalidServices,
    now: () => 0,
    authorizeForce: () => true,
  });
  const ctx = harness.context('call-invalid-output');

  const first = await boundary.invoke(
    'restart_navigation',
    { robot_id: 'R-03' },
    ctx,
  );
  const replay = await boundary.invoke(
    'restart_navigation',
    { robot_id: 'R-03' },
    ctx,
  );

  assert.equal(first.status, 'FATAL_FAILURE');
  assert.equal(first.error_code, 'OUTPUT_SCHEMA_INVALID');
  assert.equal(replay.error_code, 'CALL_REPLAY');
  assert.equal(harness.simulator.snapshot().counters.restart_navigation, 1);
  const protocol = eventsOfType(harness.trace, 'protocol_error');
  assert.equal(protocol.length, 1);
  assert.equal(protocol[0]?.data.category, 'output_schema');
});

test('protocol-rejects non-JSON output data even with exactly four fields', async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const invalidData: readonly unknown[] = [
    undefined,
    Number.NaN,
    new Error('not JSON'),
    circular,
  ];

  for (const [index, data] of invalidData.entries()) {
    const harness = createHarness();
    const invalidServices: ServicePort = {
      invoke() {
        return {
          status: 'SUCCESS',
          error_code: null,
          reason: 'invalid output fixture',
          data,
        };
      },
      snapshot() {
        return harness.services.snapshot();
      },
    };
    const boundary = new ToolBoundary({
      runId: harness.runId,
      trace: harness.trace,
      services: invalidServices,
      now: () => 0,
    });
    const result = await boundary.invoke(
      'get_robot_status',
      { robot_id: 'R-03' },
      harness.context(`call-invalid-json-${index}`),
    );

    assert.equal(result.status, 'FATAL_FAILURE');
    assert.equal(result.error_code, 'OUTPUT_SCHEMA_INVALID');
    assert.equal(eventsOfType(harness.trace, 'protocol_error').length, 1);
  }
});
test('classifies runtime and transport failures separately without retry', async () => {
  const runtimeHarness = createHarness();
  let runtimeCalls = 0;
  const runtimeServices: ServicePort = {
    invoke() {
      runtimeCalls += 1;
      throw new TypeError('unexpected runtime object shape');
    },
    snapshot() {
      return runtimeHarness.services.snapshot();
    },
  };
  const runtimeBoundary = new ToolBoundary({
    runId: runtimeHarness.runId,
    trace: runtimeHarness.trace,
    services: runtimeServices,
    now: () => 0,
  });
  const runtimeResult = await runtimeBoundary.invoke(
    'get_robot_status',
    { robot_id: 'R-03' },
    runtimeHarness.context('call-runtime'),
  );

  const transportHarness = createHarness();
  let transportCalls = 0;
  const transportServices: ServicePort = {
    invoke() {
      transportCalls += 1;
      throw new Error('network transport reset');
    },
    snapshot() {
      return transportHarness.services.snapshot();
    },
  };
  const transportBoundary = new ToolBoundary({
    runId: transportHarness.runId,
    trace: transportHarness.trace,
    services: transportServices,
    now: () => 0,
  });
  const transportResult = await transportBoundary.invoke(
    'get_robot_status',
    { robot_id: 'R-03' },
    transportHarness.context('call-transport'),
  );

  assert.equal(runtimeResult.error_code, 'RUNTIME_ERROR');
  assert.equal(runtimeCalls, 1);
  assert.equal(eventsOfType(runtimeHarness.trace, 'runtime_error').length, 1);
  assert.equal(transportResult.error_code, 'TRANSPORT_ERROR');
  assert.equal(transportCalls, 1);
  assert.equal(eventsOfType(transportHarness.trace, 'transport_error').length, 1);
});

test('bounds restart execution at two and force execution at one actual start', async () => {
  const restartHarness = createHarness({ authorizeForce: () => true });
  const firstRestart = await restartHarness.boundary.invoke(
    'restart_navigation',
    { robot_id: 'R-03' },
    restartHarness.context('call-restart-1'),
  );
  const secondRestart = await restartHarness.boundary.invoke(
    'restart_navigation',
    { robot_id: 'R-03' },
    restartHarness.context('call-restart-2'),
  );
  const thirdRestart = await restartHarness.boundary.invoke(
    'restart_navigation',
    { robot_id: 'R-03' },
    restartHarness.context('call-restart-3'),
  );

  assert.equal(firstRestart.status, 'RETRYABLE_FAILURE');
  assert.equal(secondRestart.status, 'RETRYABLE_FAILURE');
  assert.equal(thirdRestart.error_code, 'ACTION_BUDGET_EXHAUSTED');
  assert.equal(restartHarness.simulator.snapshot().counters.restart_navigation, 2);

  const forceHarness = createHarness({
    fixture: DEFAULT_FIXTURE,
    failures: { force_reboot: ['FATAL'] },
    authorizeForce: () => true,
  });
  const firstForce = await forceHarness.boundary.invoke(
    'force_reboot',
    { robot_id: 'R-03' },
    forceHarness.context('call-force-1'),
  );
  const secondForce = await forceHarness.boundary.invoke(
    'force_reboot',
    { robot_id: 'R-03' },
    forceHarness.context('call-force-2'),
  );

  assert.equal(firstForce.status, 'FATAL_FAILURE');
  assert.equal(secondForce.error_code, 'ACTION_BUDGET_EXHAUSTED');
  assert.equal(forceHarness.simulator.snapshot().counters.force_reboot, 1);
});

test('keeps active time and approval wait on separate monotonic clocks', () => {
  let now = 0;
  const harness = createHarness({
    now: () => now,
    budgets: { activeMs: 1_000, approvalMs: 500 },
  });

  now = 100;
  harness.boundary.pauseForApproval();
  now = 400;
  harness.boundary.resumeAfterApproval();
  now = 500;

  assert.deepEqual(harness.boundary.stats(), {
    tool_requests: 0,
    model_requests: 0,
    active_ms: 200,
    approval_wait_ms: 300,
    stopped: false,
    stop_reason: null,
  });
  assert.equal(harness.boundary.remainingActiveMs(), 800);
  assert.equal(harness.boundary.approvalTimeoutMs, 500);

  now = 1_000;
  harness.boundary.pauseForApproval();
  now = 1_500;
  harness.boundary.resumeAfterApproval();

  assert.deepEqual(harness.boundary.stats(), {
    tool_requests: 0,
    model_requests: 0,
    active_ms: 700,
    approval_wait_ms: 800,
    stopped: true,
    stop_reason: 'APPROVAL_BUDGET_EXHAUSTED',
  });
});

test('cancellation prevents later robot actions without rolling back prior state', async () => {
  const harness = createHarness({ fixture: IDLE_PAUSED_FIXTURE });
  const resumed = await harness.boundary.invoke(
    'resume_task',
    { robot_id: 'R-03', task_id: 'TASK-502' },
    harness.context('call-resume-before-cancel'),
  );
  assert.equal(resumed.status, 'SUCCESS');

  const controller = new AbortController();
  controller.abort();
  const cancelled = await harness.boundary.invoke(
    'restart_navigation',
    { robot_id: 'R-03' },
    harness.context('call-after-cancel', controller.signal),
  );

  const hardModelRequest = harness.boundary.noteModelRequest();
  const hardRead = await harness.boundary.invoke(
    'get_robot_status',
    { robot_id: 'R-03' },
    harness.context('call-read-after-hard-stop'),
  );
  const hardTicket = await harness.boundary.invoke(
    'create_maintenance_ticket',
    { robot_id: 'R-03', reason: 'must not dispatch after hard stop' },
    harness.context('call-ticket-after-hard-stop'),
  );

  const snapshot = harness.simulator.snapshot();
  assert.equal(cancelled.status, 'DENIED');
  assert.equal(cancelled.error_code, 'CANCELLED');
  assert.equal(snapshot.robots[0]?.state, 'MOVING');
  assert.equal(snapshot.tasks[0]?.status, 'RUNNING');
  assert.equal(snapshot.counters.restart_navigation, 0);
  assert.equal(harness.boundary.stats().stop_reason, 'CANCELLED');
  assert.equal(hardModelRequest, false);
  assert.equal(hardRead.error_code, 'RUN_STOPPED');
  assert.equal(hardTicket.error_code, 'RUN_STOPPED');
  assert.equal(harness.services.snapshot().tickets.length, 0);
});

test('fail-fast stops after the first failed robot action but permits safe cleanup', async () => {
  const harness = createHarness({ recoveryMode: 'fail-fast' });
  const failed = await harness.boundary.invoke(
    'restart_navigation',
    { robot_id: 'R-03' },
    harness.context('call-fail-fast'),
  );
  const cleanupModelRequest = harness.boundary.noteModelRequest();
  const blocked = await harness.boundary.invoke(
    'restart_navigation',
    { robot_id: 'R-03' },
    harness.context('call-after-fail-fast'),
  );
  const finalState = await harness.boundary.invoke(
    'get_robot_status',
    { robot_id: 'R-03' },
    harness.context('call-final-state'),
  );
  const ticket = await harness.boundary.invoke(
    'create_maintenance_ticket',
    { robot_id: 'R-03', reason: 'restart failed under fail-fast' },
    harness.context('call-ticket'),
  );

  assert.equal(failed.status, 'RETRYABLE_FAILURE');
  assert.equal(blocked.error_code, 'RUN_STOPPED');
  assert.equal(finalState.status, 'SUCCESS');
  assert.equal((finalState.data as { state: string }).state, 'ERROR');
  assert.equal(ticket.status, 'SUCCESS');
  assert.equal(harness.services.snapshot().tickets.length, 1);
  assert.equal(harness.boundary.stats().stop_reason, 'FAIL_FAST');
  assert.equal(cleanupModelRequest, true);
  assert.equal(eventsOfType(harness.trace, 'model_request').length, 1);
});

test('audits soft-to-hard stop escalation once and preserves hard-stop idempotency', async () => {
  const harness = createHarness({
    recoveryMode: 'fail-fast',
    budgets: { modelRequests: 1 },
  });
  const failed = await harness.boundary.invoke(
    'restart_navigation',
    { robot_id: 'R-03' },
    harness.context('call-escalate-stop'),
  );

  assert.equal(failed.status, 'RETRYABLE_FAILURE');
  assert.equal(harness.boundary.stats().stop_reason, 'FAIL_FAST');
  assert.equal(harness.boundary.noteModelRequest(), true);
  assert.equal(harness.boundary.noteModelRequest(), false);
  assert.equal(harness.boundary.stats().stop_reason, 'BUDGET_EXHAUSTED');
  assert.deepEqual(
    eventsOfType(harness.trace, 'run_stopped').map((event) => event.data),
    [{ reason: 'FAIL_FAST' }, { reason: 'BUDGET_EXHAUSTED' }],
  );

  const stoppedStats = harness.boundary.stats();
  harness.boundary.stop('BUDGET_EXHAUSTED');
  harness.boundary.stop('CANCELLED');
  harness.boundary.stop('FAIL_FAST');
  assert.equal(harness.boundary.noteModelRequest(), false);
  assert.deepEqual(harness.boundary.stats(), stoppedStats);
  const stops = eventsOfType(harness.trace, 'run_stopped');
  assert.equal(stops.length, 2);
  assert.equal(stops[1]?.data.reason, harness.boundary.stats().stop_reason);
});

test('soft stop continues active time and closes approval wait at the stop instant', async () => {
  let now = 0;
  const harness = createHarness({
    now: () => now,
    recoveryMode: 'fail-fast',
  });
  now = 100;
  harness.boundary.pauseForApproval();
  now = 200;
  const failed = await harness.boundary.invoke(
    'restart_navigation',
    { robot_id: 'R-03' },
    harness.context('call-soft-stop-clock'),
  );
  now = 1_000;

  assert.equal(failed.status, 'RETRYABLE_FAILURE');
  assert.equal(harness.boundary.noteModelRequest(), true);
  assert.deepEqual(harness.boundary.stats(), {
    tool_requests: 1,
    model_requests: 1,
    active_ms: 900,
    approval_wait_ms: 100,
    stopped: true,
    stop_reason: 'FAIL_FAST',
  });
});
test('stops on SOP_NOT_FOUND and never guesses a recovery action', async () => {
  const harness = createHarness();
  const result = await harness.boundary.invoke(
    'search_sop',
    { error_code: 'UNKNOWN_FAULT' },
    harness.context('call-missing-sop'),
  );

  assert.equal(result.status, 'FATAL_FAILURE');
  assert.equal(result.error_code, 'SOP_NOT_FOUND');
  assert.equal(harness.boundary.stats().stopped, true);
  assert.equal(harness.boundary.stats().stop_reason, 'SOP_NOT_FOUND');
  assert.equal(harness.simulator.snapshot().counters.restart_navigation, 0);
  assert.equal(harness.simulator.snapshot().counters.force_reboot, 0);
  assert.equal(harness.boundary.noteModelRequest(), true);
});

test('force preflight requires a consistent ERROR/PAUSED binding and exact fingerprint', async () => {
  const inconsistent: SimulatorFixture = {
    robots: [
      {
        robot_id: 'R-03',
        state: 'ERROR',
        battery: 31,
        error_code: 'NAV_042',
        current_task: 'TASK-502',
      },
    ],
    tasks: [
      {
        task_id: 'TASK-502',
        robot_id: 'R-99',
        status: 'PAUSED',
      },
    ],
  };
  const harness = createHarness({
    fixture: inconsistent,
    authorizeForce: () => true,
  });

  const result = await harness.boundary.invoke(
    'force_reboot',
    { robot_id: 'R-03' },
    harness.context('call-inconsistent-force'),
  );
  const fingerprint = harness.boundary.approvalFingerprint({ robot_id: 'R-03' });

  assert.equal(result.status, 'DENIED');
  assert.equal(result.error_code, 'PRECONDITION_FAILED');
  assert.equal(harness.simulator.snapshot().counters.force_reboot, 0);
  assert.equal(
    fingerprint,
    canonicalize({
      robot: inconsistent.robots[0],
      task: inconsistent.tasks[0],
    }),
  );
});

test('authorizeForce can consume an exact ledger binding before the handler', async () => {
  const harness = createHarness();
  const ledger = new ApprovalLedger({
    runId: harness.runId,
    trace: harness.trace,
    now: () => 0,
  });
  const ctx = harness.context('call-force-ledger');
  const args = { robot_id: 'R-03' };
  const fingerprint = harness.boundary.approvalFingerprint(args);
  const binding = ledger.request(ctx, args, fingerprint);
  assert.ok(binding);
  assert.equal(ledger.decide(ctx.call_id, 'approved', 'manual'), true);

  const boundary = new ToolBoundary({
    runId: harness.runId,
    trace: harness.trace,
    services: harness.services,
    now: () => 0,
    authorizeForce: (authCtx, authArgs, authFingerprint) =>
      ledger.consume(authCtx, authArgs, authFingerprint, true),
  });
  const result = await boundary.invoke('force_reboot', args, ctx);

  assert.equal(result.status, 'SUCCESS');
  assert.equal(harness.simulator.snapshot().counters.force_reboot, 1);
  assert.equal(ledger.records()[0]?.status, 'consumed');
});