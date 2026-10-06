import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_FIXTURE } from '../../src/contracts/business.js';
import type {
  ExecutionContext,
  FailureSequences,
  ResumeData,
  SimulatorFixture,
  TaskSnapshot,
  ToolResult,
} from '../../src/contracts/business.js';
import {
  BusinessServices,
  RobotService,
  SOPService,
  TicketService,
} from '../../src/services/business-services.js';
import type {
  MaintenanceTicket,
  ServicePort,
} from '../../src/services/business-services.js';
import { RobotSimulator } from '../../src/simulator/robot-simulator.js';
import { BusinessTrace } from '../../src/trace/business-trace.js';

interface HarnessOptions {
  readonly fixture?: SimulatorFixture;
  readonly failures?: Partial<FailureSequences>;
}

interface TestHarness {
  readonly services: BusinessServices;
  readonly simulator: RobotSimulator;
  readonly trace: BusinessTrace;
}

const IDLE_FIXTURE: SimulatorFixture = {
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

function createHarness(
  runId = 'run-services',
  options: HarnessOptions = {},
): TestHarness {
  const trace = new BusinessTrace({ runId, now: () => 0 });
  const simulator = new RobotSimulator({ trace, runId, ...options });
  const services = new BusinessServices({ runId, simulator, trace });
  return { services, simulator, trace };
}

function createContext(runId: string, callId: string): ExecutionContext {
  return {
    run_id: runId,
    session_id: null,
    call_id: callId,
  };
}

function requireSuccess<T>(result: ToolResult<T>): T {
  assert.equal(result.status, 'SUCCESS');
  assert.notEqual(result.data, null);
  return result.data as T;
}

function eventsOfType(
  trace: BusinessTrace,
  type: string,
): ReturnType<BusinessTrace['events']> {
  return trace.events().filter((event) => event.type === type);
}

test('BusinessServices rejects a simulator from another run without side effects', () => {
  const simulatorTrace = new BusinessTrace({ runId: 'run-simulator', now: () => 0 });
  const serviceTrace = new BusinessTrace({ runId: 'run-services', now: () => 0 });
  const simulator = new RobotSimulator({
    runId: 'run-simulator',
    trace: simulatorTrace,
  });
  const beforeSnapshot = simulator.snapshot();
  const beforeSimulatorEvents = simulatorTrace.events();
  const beforeServiceEvents = serviceTrace.events();

  assert.throws(
    () => new BusinessServices({
      runId: 'run-services',
      simulator,
      trace: serviceTrace,
    }),
    /simulator trace must be the same instance as services trace/,
  );

  assert.deepEqual(simulator.snapshot(), beforeSnapshot);
  assert.deepEqual(simulatorTrace.events(), beforeSimulatorEvents);
  assert.deepEqual(serviceTrace.events(), beforeServiceEvents);
});

test('BusinessServices rejects distinct trace instances for the same run without side effects', () => {
  const runId = 'run-split-trace';
  const simulatorTrace = new BusinessTrace({ runId, now: () => 0 });
  const serviceTrace = new BusinessTrace({ runId, now: () => 0 });
  const simulator = new RobotSimulator({ runId, trace: simulatorTrace });
  const beforeSnapshot = simulator.snapshot();
  const beforeSimulatorEvents = simulatorTrace.events();
  const beforeServiceEvents = serviceTrace.events();

  assert.throws(
    () => new BusinessServices({ runId, simulator, trace: serviceTrace }),
    /simulator trace must be the same instance as services trace/,
  );

  assert.deepEqual(simulator.snapshot(), beforeSnapshot);
  assert.deepEqual(simulatorTrace.events(), beforeSimulatorEvents);
  assert.deepEqual(serviceTrace.events(), beforeServiceEvents);
});

test('RobotService validates identifiers and directly proxies all five simulator methods', () => {
  const restartHarness = createHarness('run-robot-service', {
    failures: { restart_navigation: ['SUCCESS'] },
  });
  const robotService = new RobotService(restartHarness.simulator);

  assert.throws(
    () => robotService.getRobotStatus('', 'call-robot'),
    /robotId must be a non-empty string/,
  );
  assert.throws(
    () => robotService.getTaskStatus('TASK-502', ' '),
    /callId must be a non-empty string/,
  );
  assert.throws(
    () => robotService.resumeTask('R-03', '', 'call-resume'),
    /taskId must be a non-empty string/,
  );

  const robot = requireSuccess(
    robotService.getRobotStatus('R-03', 'call-robot'),
  );
  assert.deepEqual(robot, {
    robot_id: 'R-03',
    state: 'ERROR',
    battery: 31,
    error_code: 'NAV_042',
    current_task: 'TASK-502',
  });

  const task = requireSuccess(
    robotService.getTaskStatus('TASK-502', 'call-task'),
  );
  assert.deepEqual(task, {
    task_id: 'TASK-502',
    robot_id: 'R-03',
    status: 'PAUSED',
  });

  const restarted = requireSuccess(
    robotService.restartNavigation('R-03', 'call-restart'),
  );
  assert.equal(restarted.state, 'IDLE');
  assert.equal(restarted.error_code, null);

  const resumed = requireSuccess(
    robotService.resumeTask('R-03', 'TASK-502', 'call-resume'),
  );
  assert.equal(resumed.already_resumed, false);
  assert.equal(resumed.robot.state, 'MOVING');
  assert.equal(resumed.task.status, 'RUNNING');

  const forceHarness = createHarness('run-force-service');
  const forced = requireSuccess(
    new RobotService(forceHarness.simulator).forceReboot(
      'R-03',
      'call-force',
    ),
  );
  assert.equal(forced.state, 'IDLE');
  assert.equal(forced.error_code, null);

  assert.deepEqual(
    robotService.getRobotStatus('missing', 'call-missing'),
    {
      status: 'FATAL_FAILURE',
      error_code: 'ROBOT_NOT_FOUND',
      reason: 'robot missing was not found',
      data: null,
    },
  );
  assert.deepEqual(
    robotService.getTaskStatus('missing', 'call-missing-task'),
    {
      status: 'FATAL_FAILURE',
      error_code: 'TASK_NOT_FOUND',
      reason: 'task missing was not found',
      data: null,
    },
  );
});

test('BusinessServices routes all seven tool names through their service paths', () => {
  const harness = createHarness('run-seven-tools', {
    failures: { restart_navigation: ['SUCCESS'] },
  });
  const invoke = (name: Parameters<BusinessServices['invoke']>[0], args: Record<string, string>, callId: string): ToolResult =>
    harness.services.invoke(
      name,
      args,
      createContext('run-seven-tools', callId),
    );

  assert.equal(
    invoke('get_robot_status', { robot_id: 'R-03' }, 'call-1').status,
    'SUCCESS',
  );
  assert.equal(
    invoke('get_task_status', { task_id: 'TASK-502' }, 'call-2').status,
    'SUCCESS',
  );
  assert.equal(
    invoke('search_sop', { error_code: 'NAV_042' }, 'call-3').status,
    'SUCCESS',
  );
  assert.equal(
    invoke('force_reboot', { robot_id: 'R-03' }, 'call-4').status,
    'SUCCESS',
  );
  assert.deepEqual(
    invoke('restart_navigation', { robot_id: 'R-03' }, 'call-5'),
    {
      status: 'DENIED',
      error_code: 'PRECONDITION_FAILED',
      reason: 'robot R-03 must be in ERROR state with an active fault',
      data: null,
    },
  );
  const resumed = invoke(
    'resume_task',
    { robot_id: 'R-03', task_id: 'TASK-502' },
    'call-6',
  );
  assert.equal(resumed.status, 'SUCCESS');
  const ticket = invoke(
    'create_maintenance_ticket',
    { robot_id: 'R-03', reason: 'navigation fault' },
    'call-7',
  );
  assert.equal(ticket.status, 'SUCCESS');
  assert.equal(harness.services.snapshot().tickets.length, 1);
});

test('invoke enforces the host run id and records request/result trace fields', () => {
  const harness = createHarness('run-context');
  const result = harness.services.invoke(
    'get_robot_status',
    { robot_id: 'R-03' },
    createContext('run-context', 'call-trace'),
  );

  assert.equal(result.status, 'SUCCESS');
  const called = eventsOfType(harness.trace, 'service_called').at(-1);
  assert.equal(called?.run_id, 'run-context');
  assert.equal(called?.call_id, 'call-trace');
  assert.deepEqual(called?.data, {
    tool_name: 'get_robot_status',
    args: { robot_id: 'R-03' },
  });

  const recorded = eventsOfType(harness.trace, 'service_result').at(-1);
  assert.equal(recorded?.run_id, 'run-context');
  assert.equal(recorded?.call_id, 'call-trace');
  assert.deepEqual(recorded?.data, {
    tool_name: 'get_robot_status',
    result,
  });

  const denied = harness.services.invoke(
    'search_sop',
    { error_code: 'NAV_042' },
    createContext('run-other', 'call-denied'),
  );
  assert.deepEqual(denied, {
    status: 'DENIED',
    error_code: 'CONTEXT_MISMATCH',
    reason:
      'context run_id run-other does not match service run_id run-context',
    data: null,
  });
  assert.equal(
    eventsOfType(harness.trace, 'service_result').at(-1)?.call_id,
    'call-denied',
  );
  assert.deepEqual(harness.services.snapshot().simulator.counters, {
    restart_navigation: 0,
    force_reboot: 0,
    resume_task: 0,
  });
});

test('SOPService returns NAV_042 data and safely reports missing SOPs', () => {
  const sopService = new SOPService();
  const found = sopService.searchSop('NAV_042');
  assert.equal(found.status, 'SUCCESS');
  assert.deepEqual(found.data, {
    error_code: 'NAV_042',
    title: 'NAV_042 navigation fault recovery',
    steps: [
      '验证机器人任务双向绑定',
      '最多两次 restart 并读取成功状态',
      '连续失败申请 force 批准',
      'force 后读 IDLE/no fault',
      'resume 后读 robot/task',
    ],
  });

  assert.deepEqual(sopService.searchSop('NAV_999'), {
    status: 'FATAL_FAILURE',
    error_code: 'SOP_NOT_FOUND',
    reason: 'SOP for error code NAV_999 was not found',
    data: null,
  });
  assert.throws(
    () => sopService.searchSop(' '),
    /errorCode must be a non-empty string/,
  );
});

test('TicketService deduplicates exact identities and emits created/reused events', () => {
  const trace = new BusinessTrace({ runId: 'run-ticket', now: () => 0 });
  const ticketService = new TicketService('run-ticket', trace);

  const first = requireSuccess(
    ticketService.create('R-03', 'navigation fault', 'call-create'),
  );
  const reused = requireSuccess(
    ticketService.create('R-03', 'navigation fault', 'call-reuse'),
  );
  const otherReason = requireSuccess(
    ticketService.create('R-03', 'battery fault', 'call-other'),
  );

  assert.deepEqual(reused, first);
  assert.equal(first.ticket_id, 'run-ticket-1');
  assert.equal(otherReason.ticket_id, 'run-ticket-2');
  assert.deepEqual(ticketService.list(), [first, otherReason]);
  assert.deepEqual(
    trace
      .events()
      .filter((event) => event.type.startsWith('ticket_'))
      .map((event) => event.type),
    ['ticket_created', 'ticket_reused', 'ticket_created'],
  );

  assert.throws(
    () => ticketService.create('', 'reason', 'call-invalid'),
    /robotId must be a non-empty string/,
  );
});

test('ticket identities are isolated across runs and snapshots are defensive', () => {
  const firstHarness = createHarness('run-a');
  const secondHarness = createHarness('run-b');

  const firstTicket = requireSuccess(
    firstHarness.services.invoke(
      'create_maintenance_ticket',
      { robot_id: 'R-03', reason: 'navigation fault' },
      createContext('run-a', 'call-a-1'),
    ),
  ) as unknown as MaintenanceTicket;
  const secondTicket = requireSuccess(
    secondHarness.services.invoke(
      'create_maintenance_ticket',
      { robot_id: 'R-03', reason: 'navigation fault' },
      createContext('run-b', 'call-b-1'),
    ),
  ) as unknown as MaintenanceTicket;

  assert.equal(firstTicket.run_id, 'run-a');
  assert.equal(secondTicket.run_id, 'run-b');
  assert.notEqual(firstTicket.ticket_id, secondTicket.ticket_id);
  assert.equal(firstHarness.services.snapshot().tickets.length, 1);
  assert.equal(secondHarness.services.snapshot().tickets.length, 1);

  const leaked = firstHarness.services.snapshot();
  const mutableRobots = leaked.simulator.robots as unknown as Array<{
    state: string;
  }>;
  mutableRobots[0]!.state = 'OFFLINE';
  const mutableCounters = leaked.simulator.counters as Record<string, number>;
  mutableCounters.restart_navigation = 99;
  leaked.tickets.push({
    ticket_id: 'forged',
    run_id: 'run-a',
    robot_id: 'R-03',
    reason: 'forged',
  });
  (leaked.tickets[0] as unknown as { reason: string }).reason = 'changed';

  const fresh = firstHarness.services.snapshot();
  assert.equal(fresh.simulator.robots[0]?.state, 'ERROR');
  assert.equal(fresh.simulator.counters.restart_navigation, 0);
  assert.equal(fresh.tickets.length, 1);
  assert.equal(fresh.tickets[0]?.reason, 'navigation fault');
});

test('ticket creation checks simulator snapshots without fabricating a state read', () => {
  const harness = createHarness('run-missing-robot');
  const result = harness.services.invoke(
    'create_maintenance_ticket',
    { robot_id: 'R-404', reason: 'missing robot' },
    createContext('run-missing-robot', 'call-missing'),
  );

  assert.deepEqual(result, {
    status: 'FATAL_FAILURE',
    error_code: 'ROBOT_NOT_FOUND',
    reason: 'robot R-404 was not found',
    data: null,
  });
  assert.equal(harness.services.snapshot().tickets.length, 0);
  assert.equal(eventsOfType(harness.trace, 'state_read').length, 0);
  assert.equal(eventsOfType(harness.trace, 'ticket_created').length, 0);
});

test('resume_task is idempotent after the first successful resume', () => {
  const harness = createHarness('run-resume-idempotent', {
    fixture: IDLE_FIXTURE,
  });
  const first = harness.services.invoke(
    'resume_task',
    { robot_id: 'R-03', task_id: 'TASK-502' },
    createContext('run-resume-idempotent', 'call-resume-1'),
  );
  const second = harness.services.invoke(
    'resume_task',
    { robot_id: 'R-03', task_id: 'TASK-502' },
    createContext('run-resume-idempotent', 'call-resume-2'),
  );

  const firstData = requireSuccess(first) as unknown as ResumeData;
  const secondData = requireSuccess(second) as unknown as ResumeData;
  assert.equal(firstData.already_resumed, false);
  assert.equal(secondData.already_resumed, true);
  assert.equal(secondData.robot.state, 'MOVING');
  assert.equal(secondData.task.status, 'RUNNING');
  assert.equal(
    harness.services.snapshot().simulator.counters.resume_task,
    1,
  );
});

test('BusinessServices satisfies ServicePort and defaults expose the approved fixture', () => {
  const harness = createHarness('run-port');
  const port: ServicePort = harness.services;
  const result = port.invoke(
    'get_task_status',
    { task_id: 'TASK-502' },
    createContext('run-port', 'call-port'),
  );

  assert.ok(result instanceof Promise === false);
  assert.equal((result as ToolResult<TaskSnapshot>).status, 'SUCCESS');
  const simulatorSnapshot = port.snapshot().simulator;
  assert.deepEqual(simulatorSnapshot.robots, DEFAULT_FIXTURE.robots);
  assert.deepEqual(simulatorSnapshot.tasks, DEFAULT_FIXTURE.tasks);
});



