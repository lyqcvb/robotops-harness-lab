import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_FAILURES,
  DEFAULT_FIXTURE,
} from '../../src/contracts/business.js';
import type {
  ActionName,
  FailureSequences,
  RobotSnapshot,
  SimulatorFixture,
  SimulatorSnapshot,
  TaskSnapshot,
} from '../../src/contracts/business.js';
import { RobotSimulator } from '../../src/simulator/robot-simulator.js';
import { BusinessTrace } from '../../src/trace/business-trace.js';

interface SimulatorTestOptions {
  readonly fixture?: SimulatorFixture;
  readonly failures?: Partial<FailureSequences>;
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

function createSimulator(
  runId: string,
  options: SimulatorTestOptions = {},
): { readonly simulator: RobotSimulator; readonly trace: BusinessTrace } {
  const trace = new BusinessTrace({ runId, now: () => 0 });
  const simulator = new RobotSimulator({ runId, trace, ...options });
  return { simulator, trace };
}

function eventsOfType(
  trace: BusinessTrace,
  type: string,
): ReturnType<BusinessTrace['events']> {
  return trace.events().filter((event) => event.type === type);
}

function requireRobot(
  result: ReturnType<RobotSimulator['getRobotStatus']>,
): RobotSnapshot {
  assert.equal(result.status, 'SUCCESS');
  assert.ok(result.data);
  return result.data;
}

function requireTask(
  result: ReturnType<RobotSimulator['getTaskStatus']>,
): TaskSnapshot {
  assert.equal(result.status, 'SUCCESS');
  assert.ok(result.data);
  return result.data;
}

test('defaults expose the core ERROR/NAV_042/PAUSED fixture and timeout sequence', () => {
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
    tasks: [
      {
        task_id: 'TASK-502',
        robot_id: 'R-03',
        status: 'PAUSED',
      },
    ],
  });
  assert.deepEqual(DEFAULT_FAILURES, {
    restart_navigation: ['TIMEOUT', 'TIMEOUT'],
    force_reboot: ['SUCCESS'],
  });
});

test('initialization records a cloned snapshot under the supplied run id', () => {
  const { simulator, trace } = createSimulator('run-init');
  const events = trace.events();

  assert.equal(events.length, 1);
  assert.equal(events[0]?.run_id, 'run-init');
  assert.equal(events[0]?.call_id, null);
  assert.equal(events[0]?.seq, 1);
  assert.equal(events[0]?.type, 'simulator_initialized');
  assert.deepEqual(events[0]?.data.snapshot, simulator.snapshot());
});

test('constructor rejects a trace from another run without recording initialization', () => {
  const trace = new BusinessTrace({ runId: 'run-other', now: () => 0 });

  assert.throws(
    () => new RobotSimulator({ runId: 'run-expected', trace }),
    /does not match/,
  );
  assert.deepEqual(trace.events(), []);
});

test('fixture and failure sequences are copied at construction time', () => {
  const robot: RobotSnapshot = {
    robot_id: 'R-03',
    state: 'ERROR',
    battery: 31,
    error_code: 'NAV_042',
    current_task: 'TASK-502',
  };
  const task: TaskSnapshot = {
    task_id: 'TASK-502',
    robot_id: 'R-03',
    status: 'PAUSED',
  };
  const restarts: ('TIMEOUT' | 'FATAL' | 'SUCCESS')[] = ['SUCCESS'];
  const fixture: SimulatorFixture = { robots: [robot], tasks: [task] };
  const { simulator } = createSimulator('run-copy', {
    fixture,
    failures: { restart_navigation: restarts },
  });

  const mutableRobot = robot as { state: RobotSnapshot['state'] };
  const mutableTask = task as { status: TaskSnapshot['status'] };
  mutableRobot.state = 'OFFLINE';
  mutableTask.status = 'FAILED';
  restarts[0] = 'TIMEOUT';

  assert.equal(simulator.snapshot().robots[0]?.state, 'ERROR');
  assert.equal(simulator.snapshot().tasks[0]?.status, 'PAUSED');
  assert.equal(simulator.restartNavigation('R-03', 'call-copy').status, 'SUCCESS');
});

test('robot and task reads return snapshots and record call-linked state_read events', () => {
  const { simulator, trace } = createSimulator('run-read');

  const robot = requireRobot(simulator.getRobotStatus('R-03', 'call-robot'));
  const task = requireTask(simulator.getTaskStatus('TASK-502', 'call-task'));
  const missingRobot = simulator.getRobotStatus('R-99', 'call-missing-robot');
  const missingTask = simulator.getTaskStatus('TASK-999', 'call-missing-task');

  assert.deepEqual(robot, DEFAULT_FIXTURE.robots[0]);
  assert.deepEqual(task, DEFAULT_FIXTURE.tasks[0]);
  assert.equal(missingRobot.status, 'FATAL_FAILURE');
  assert.equal(missingRobot.error_code, 'ROBOT_NOT_FOUND');
  assert.equal(missingTask.status, 'FATAL_FAILURE');
  assert.equal(missingTask.error_code, 'TASK_NOT_FOUND');

  const reads = eventsOfType(trace, 'state_read');
  assert.deepEqual(
    reads.map((event) => [event.call_id, event.data.entity]),
    [
      ['call-robot', 'robot'],
      ['call-task', 'task'],
      ['call-missing-robot', 'robot'],
      ['call-missing-task', 'task'],
    ],
  );
  assert.deepEqual(simulator.snapshot(), {
    robots: [...DEFAULT_FIXTURE.robots],
    tasks: [...DEFAULT_FIXTURE.tasks],
    counters: {
      restart_navigation: 0,
      force_reboot: 0,
      resume_task: 0,
    },
    cursors: {
      restart_navigation: 0,
      force_reboot: 0,
    },
  });
});

test('read results and simulator snapshots do not expose mutable internal references', () => {
  const { simulator } = createSimulator('run-isolation');
  const firstRobot = requireRobot(simulator.getRobotStatus('R-03', 'read-1'));
  const secondRobot = requireRobot(simulator.getRobotStatus('R-03', 'read-2'));
  const firstSnapshot = simulator.snapshot();
  const secondSnapshot = simulator.snapshot();

  assert.notStrictEqual(firstRobot, secondRobot);
  assert.notStrictEqual(firstSnapshot, secondSnapshot);
  assert.notStrictEqual(firstSnapshot.robots, secondSnapshot.robots);

  const mutableRobot: { state: RobotSnapshot['state'] } = firstRobot;
  const mutableCounters: Record<ActionName, number> = firstSnapshot.counters;
  mutableRobot.state = 'OFFLINE';
  mutableCounters.restart_navigation = 99;

  assert.equal(simulator.snapshot().robots[0]?.state, 'ERROR');
  assert.equal(simulator.snapshot().counters.restart_navigation, 0);
});

test('restart navigation success clears the fault and records one state change', () => {
  const { simulator, trace } = createSimulator('run-restart-success', {
    failures: { restart_navigation: ['SUCCESS'] },
  });

  const result = simulator.restartNavigation('R-03', 'call-restart-success');

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.error_code, null);
  assert.equal(result.data?.state, 'IDLE');
  assert.equal(result.data?.error_code, null);
  assert.deepEqual(simulator.snapshot().counters, {
    restart_navigation: 1,
    force_reboot: 0,
    resume_task: 0,
  });
  assert.deepEqual(simulator.snapshot().cursors, {
    restart_navigation: 1,
    force_reboot: 0,
  });

  const actionEvents = trace.events().filter((event) => event.call_id === 'call-restart-success');
  assert.deepEqual(
    actionEvents.map((event) => event.type),
    ['action_started', 'state_changed', 'action_finished'],
  );
  const stateChange = eventsOfType(trace, 'state_changed')[0];
  const before = stateChange?.data.before as SimulatorSnapshot;
  const after = stateChange?.data.after as SimulatorSnapshot;
  assert.equal(before.robots[0]?.state, 'ERROR');
  assert.equal(before.robots[0]?.error_code, 'NAV_042');
  assert.equal(after.robots[0]?.state, 'IDLE');
  assert.equal(after.robots[0]?.error_code, null);
});

test('restart navigation timeout consumes one item, preserves state, and is retryable', () => {
  const { simulator, trace } = createSimulator('run-restart-timeout');
  const before = simulator.snapshot();

  const result = simulator.restartNavigation('R-03', 'call-timeout');

  assert.equal(result.status, 'RETRYABLE_FAILURE');
  assert.equal(result.error_code, 'TIMEOUT');
  assert.equal(result.data, null);
  assert.equal(simulator.snapshot().robots[0]?.state, 'ERROR');
  assert.equal(simulator.snapshot().robots[0]?.error_code, 'NAV_042');
  assert.equal(simulator.snapshot().counters.restart_navigation, 1);
  assert.equal(simulator.snapshot().cursors.restart_navigation, 1);
  assert.notDeepEqual(simulator.snapshot(), before);
  assert.equal(eventsOfType(trace, 'state_changed').length, 0);
  assert.deepEqual(
    trace.events().filter((event) => event.call_id === 'call-timeout').map((event) => event.type),
    ['action_started', 'action_finished'],
  );
});

test('restart navigation fatal outcome preserves the fault and counters the execution', () => {
  const { simulator } = createSimulator('run-restart-fatal', {
    failures: { restart_navigation: ['FATAL'] },
  });

  const result = simulator.restartNavigation('R-03', 'call-fatal');

  assert.equal(result.status, 'FATAL_FAILURE');
  assert.equal(result.error_code, 'ACTION_FAILED');
  assert.equal(result.data, null);
  assert.equal(simulator.snapshot().robots[0]?.state, 'ERROR');
  assert.equal(simulator.snapshot().robots[0]?.error_code, 'NAV_042');
  assert.equal(simulator.snapshot().counters.restart_navigation, 1);
  assert.equal(simulator.snapshot().cursors.restart_navigation, 1);
});

test('restart failure sequence is consumed item by item and exhausts explicitly', () => {
  const { simulator, trace } = createSimulator('run-exhaustion');

  const first = simulator.restartNavigation('R-03', 'call-1');
  const second = simulator.restartNavigation('R-03', 'call-2');
  const third = simulator.restartNavigation('R-03', 'call-3');

  assert.equal(first.status, 'RETRYABLE_FAILURE');
  assert.equal(first.error_code, 'TIMEOUT');
  assert.equal(second.status, 'RETRYABLE_FAILURE');
  assert.equal(second.error_code, 'TIMEOUT');
  assert.equal(third.status, 'FATAL_FAILURE');
  assert.equal(third.error_code, 'FAULT_SEQUENCE_EXHAUSTED');
  assert.equal(simulator.snapshot().counters.restart_navigation, 3);
  assert.equal(simulator.snapshot().cursors.restart_navigation, 2);
  assert.equal(eventsOfType(trace, 'state_changed').length, 0);
});

test('an empty injected sequence fails explicitly instead of defaulting to success', () => {
  const { simulator } = createSimulator('run-empty-sequence', {
    failures: { force_reboot: [] },
  });

  const result = simulator.forceReboot('R-03', 'call-empty');

  assert.equal(result.status, 'FATAL_FAILURE');
  assert.equal(result.error_code, 'FAULT_SEQUENCE_EXHAUSTED');
  assert.equal(simulator.snapshot().robots[0]?.state, 'ERROR');
  assert.equal(simulator.snapshot().robots[0]?.error_code, 'NAV_042');
  assert.equal(simulator.snapshot().counters.force_reboot, 1);
  assert.equal(simulator.snapshot().cursors.force_reboot, 0);
});

test('restart navigation precondition failure does not start or consume an action', () => {
  const { simulator, trace } = createSimulator('run-restart-precondition', {
    fixture: IDLE_FIXTURE,
  });

  const result = simulator.restartNavigation('R-03', 'call-denied');

  assert.equal(result.status, 'DENIED');
  assert.equal(result.error_code, 'PRECONDITION_FAILED');
  assert.deepEqual(simulator.snapshot().counters, {
    restart_navigation: 0,
    force_reboot: 0,
    resume_task: 0,
  });
  assert.deepEqual(simulator.snapshot().cursors, {
    restart_navigation: 0,
    force_reboot: 0,
  });
  assert.equal(eventsOfType(trace, 'action_started').length, 0);
});

test('force reboot success records ERROR to REBOOTING to IDLE and clears the fault', () => {
  const { simulator, trace } = createSimulator('run-force-success');

  const result = simulator.forceReboot('R-03', 'call-force');

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.data?.state, 'IDLE');
  assert.equal(result.data?.error_code, null);
  assert.equal(simulator.snapshot().counters.force_reboot, 1);
  assert.equal(simulator.snapshot().cursors.force_reboot, 1);

  const stateChanges = eventsOfType(trace, 'state_changed');
  assert.equal(stateChanges.length, 2);
  const firstBefore = stateChanges[0]?.data.before as SimulatorSnapshot;
  const firstAfter = stateChanges[0]?.data.after as SimulatorSnapshot;
  const secondBefore = stateChanges[1]?.data.before as SimulatorSnapshot;
  const secondAfter = stateChanges[1]?.data.after as SimulatorSnapshot;
  assert.equal(firstBefore.robots[0]?.state, 'ERROR');
  assert.equal(firstAfter.robots[0]?.state, 'REBOOTING');
  assert.equal(firstAfter.robots[0]?.error_code, 'NAV_042');
  assert.equal(secondBefore.robots[0]?.state, 'REBOOTING');
  assert.equal(secondAfter.robots[0]?.state, 'IDLE');
  assert.equal(secondAfter.robots[0]?.error_code, null);
  assert.deepEqual(
    trace.events().filter((event) => event.call_id === 'call-force').map((event) => event.type),
    ['action_started', 'state_changed', 'state_changed', 'action_finished'],
  );
});

test('force reboot failures do not clear the fault or create a transition', () => {
  const timeout = createSimulator('run-force-timeout', {
    failures: { force_reboot: ['TIMEOUT'] },
  });
  const fatal = createSimulator('run-force-fatal', {
    failures: { force_reboot: ['FATAL'] },
  });

  const timeoutResult = timeout.simulator.forceReboot('R-03', 'force-timeout');
  const fatalResult = fatal.simulator.forceReboot('R-03', 'force-fatal');

  assert.equal(timeoutResult.status, 'RETRYABLE_FAILURE');
  assert.equal(timeoutResult.error_code, 'TIMEOUT');
  assert.equal(fatalResult.status, 'FATAL_FAILURE');
  assert.equal(fatalResult.error_code, 'ACTION_FAILED');
  for (const current of [timeout.simulator, fatal.simulator]) {
    const robot = current.snapshot().robots[0];
    assert.equal(robot?.state, 'ERROR');
    assert.equal(robot?.error_code, 'NAV_042');
  }
  assert.equal(eventsOfType(timeout.trace, 'state_changed').length, 0);
  assert.equal(eventsOfType(fatal.trace, 'state_changed').length, 0);
});

test('force reboot precondition failure leaves counters and cursors untouched', () => {
  const { simulator, trace } = createSimulator('run-force-precondition', {
    fixture: IDLE_FIXTURE,
  });

  const result = simulator.forceReboot('R-03', 'force-denied');

  assert.equal(result.status, 'DENIED');
  assert.equal(result.error_code, 'PRECONDITION_FAILED');
  assert.equal(simulator.snapshot().counters.force_reboot, 0);
  assert.equal(simulator.snapshot().cursors.force_reboot, 0);
  assert.equal(eventsOfType(trace, 'action_started').length, 0);
});

test('resume task succeeds only for the exact IDLE no-fault PAUSED binding', () => {
  const { simulator, trace } = createSimulator('run-resume-success', {
    fixture: IDLE_FIXTURE,
  });

  const result = simulator.resumeTask('R-03', 'TASK-502', 'resume-once');

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.error_code, null);
  assert.equal(result.data?.already_resumed, false);
  assert.deepEqual(result.data?.robot, {
    robot_id: 'R-03',
    state: 'MOVING',
    battery: 31,
    error_code: null,
    current_task: 'TASK-502',
  });
  assert.deepEqual(result.data?.task, {
    task_id: 'TASK-502',
    robot_id: 'R-03',
    status: 'RUNNING',
  });
  assert.equal(simulator.snapshot().counters.resume_task, 1);
  assert.deepEqual(
    trace.events().filter((event) => event.call_id === 'resume-once').map((event) => event.type),
    ['action_started', 'state_changed', 'action_finished'],
  );
});

test('resume task is side-effect free when the exact target binding is already resumed', () => {
  const { simulator, trace } = createSimulator('run-resume-idempotent', {
    fixture: IDLE_FIXTURE,
  });
  simulator.resumeTask('R-03', 'TASK-502', 'resume-first');
  const snapshotBefore = simulator.snapshot();

  const result = simulator.resumeTask('R-03', 'TASK-502', 'resume-second');

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.data?.already_resumed, true);
  assert.deepEqual(simulator.snapshot(), snapshotBefore);
  assert.equal(
    trace.events().filter(
      (event) => event.call_id === 'resume-second' && event.type === 'action_started',
    ).length,
    0,
  );
  assert.equal(eventsOfType(trace, 'state_changed').length, 1);
});

test('resume task rejects both robot-task binding mismatches without consuming an action', () => {
  const wrongTaskOwner = createSimulator('run-resume-binding-task', {
    fixture: {
      robots: IDLE_FIXTURE.robots,
      tasks: [
        {
          task_id: 'TASK-502',
          robot_id: 'R-04',
          status: 'PAUSED',
        },
      ],
    },
  });
  const wrongCurrentTask = createSimulator('run-resume-binding-current', {
    fixture: {
      robots: [
        {
          ...IDLE_FIXTURE.robots[0]!,
          current_task: 'TASK-999',
        },
      ],
      tasks: IDLE_FIXTURE.tasks,
    },
  });

  const taskOwnerResult = wrongTaskOwner.simulator.resumeTask(
    'R-03',
    'TASK-502',
    'binding-task',
  );
  const currentTaskResult = wrongCurrentTask.simulator.resumeTask(
    'R-03',
    'TASK-502',
    'binding-current',
  );

  for (const result of [taskOwnerResult, currentTaskResult]) {
    assert.equal(result.status, 'DENIED');
    assert.equal(result.error_code, 'BINDING_MISMATCH');
  }
  assert.equal(wrongTaskOwner.simulator.snapshot().counters.resume_task, 0);
  assert.equal(wrongCurrentTask.simulator.snapshot().counters.resume_task, 0);
});

test('resume task rejects mismatched robot and task states with PRECONDITION_FAILED', () => {
  const robotNotIdle = createSimulator('run-resume-robot-state', {
    fixture: {
      robots: DEFAULT_FIXTURE.robots,
      tasks: IDLE_FIXTURE.tasks,
    },
  });
  const taskNotPaused = createSimulator('run-resume-task-state', {
    fixture: {
      robots: IDLE_FIXTURE.robots,
      tasks: [
        {
          task_id: 'TASK-502',
          robot_id: 'R-03',
          status: 'RUNNING',
        },
      ],
    },
  });

  const robotResult = robotNotIdle.simulator.resumeTask('R-03', 'TASK-502', 'state-robot');
  const taskResult = taskNotPaused.simulator.resumeTask('R-03', 'TASK-502', 'state-task');

  assert.equal(robotResult.status, 'DENIED');
  assert.equal(robotResult.error_code, 'PRECONDITION_FAILED');
  assert.equal(taskResult.status, 'DENIED');
  assert.equal(taskResult.error_code, 'PRECONDITION_FAILED');
  assert.equal(robotNotIdle.simulator.snapshot().counters.resume_task, 0);
  assert.equal(taskNotPaused.simulator.snapshot().counters.resume_task, 0);
});

test('missing robots and tasks return distinct errors without action side effects', () => {
  const { simulator, trace } = createSimulator('run-missing-objects');

  const missingRobot = simulator.restartNavigation('R-99', 'missing-robot-action');
  const missingTask = simulator.resumeTask('R-03', 'TASK-999', 'missing-task-action');
  const missingResumeRobot = simulator.resumeTask('R-99', 'TASK-502', 'missing-robot-resume');

  assert.equal(missingRobot.status, 'FATAL_FAILURE');
  assert.equal(missingRobot.error_code, 'ROBOT_NOT_FOUND');
  assert.equal(missingTask.status, 'FATAL_FAILURE');
  assert.equal(missingTask.error_code, 'TASK_NOT_FOUND');
  assert.equal(missingResumeRobot.status, 'FATAL_FAILURE');
  assert.equal(missingResumeRobot.error_code, 'ROBOT_NOT_FOUND');
  assert.deepEqual(simulator.snapshot().counters, {
    restart_navigation: 0,
    force_reboot: 0,
    resume_task: 0,
  });
  assert.equal(eventsOfType(trace, 'action_started').length, 0);
});

test('new runs created as new instances have isolated state, counters, cursors, and traces', () => {
  const first = createSimulator('run-a');
  const second = createSimulator('run-b');
  const firstBefore = first.simulator.snapshot();

  first.simulator.restartNavigation('R-03', 'run-a-call');
  first.simulator.restartNavigation('R-03', 'run-a-call-2');

  assert.deepEqual(second.simulator.snapshot(), firstBefore);
  assert.equal(second.trace.runId, 'run-b');
  assert.equal(second.trace.events().length, 1);
  assert.equal(second.trace.events()[0]?.type, 'simulator_initialized');
});

test('trace preserves run, sequence, call association, and event order across calls', () => {
  const { simulator, trace } = createSimulator('run-trace');
  simulator.getRobotStatus('R-03', 'read-a');
  simulator.getTaskStatus('TASK-502', 'read-b');
  simulator.restartNavigation('R-03', 'action-a');

  const events = trace.events();
  assert.deepEqual(
    events.map((event) => event.seq),
    events.map((_, index) => index + 1),
  );
  assert.ok(events.every((event) => event.run_id === 'run-trace'));
  assert.deepEqual(
    events.filter((event) => event.call_id === 'read-a').map((event) => event.type),
    ['state_read'],
  );
  assert.deepEqual(
    events.filter((event) => event.call_id === 'read-b').map((event) => event.type),
    ['state_read'],
  );
  assert.deepEqual(
    events.filter((event) => event.call_id === 'action-a').map((event) => event.type),
    ['action_started', 'action_finished'],
  );
});


