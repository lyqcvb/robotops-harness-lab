import type {
  ActionName,
  ActionOutcome,
  FailureSequences,
  ResumeData,
  RobotSnapshot,
  SimulatorFixture,
  SimulatorSnapshot,
  TaskSnapshot,
  ToolResult,
} from '../contracts/business.js';
import { DEFAULT_FAILURES, DEFAULT_FIXTURE } from '../contracts/business.js';
import type { BusinessTrace } from '../trace/business-trace.js';

type InjectedActionName = 'restart_navigation' | 'force_reboot';

export interface RobotSimulatorOptions {
  readonly runId: string;
  readonly trace: BusinessTrace;
  readonly fixture?: SimulatorFixture;
  readonly failures?: Partial<FailureSequences>;
}

type MutableRobotSnapshot = {
  -readonly [Key in keyof RobotSnapshot]: RobotSnapshot[Key];
};

type MutableTaskSnapshot = {
  -readonly [Key in keyof TaskSnapshot]: TaskSnapshot[Key];
};

interface MutableSimulatorFixture {
  readonly robots: MutableRobotSnapshot[];
  readonly tasks: MutableTaskSnapshot[];
}
function cloneRobot(robot: RobotSnapshot): MutableRobotSnapshot {
  return { ...robot };
}

function cloneTask(task: TaskSnapshot): MutableTaskSnapshot {
  return { ...task };
}

function cloneFixture(fixture: SimulatorFixture): MutableSimulatorFixture {
  return {
    robots: fixture.robots.map(cloneRobot),
    tasks: fixture.tasks.map(cloneTask),
  };
}

function success<T>(data: T, reason: string): ToolResult<T> {
  return {
    status: 'SUCCESS',
    error_code: null,
    reason,
    data,
  };
}

function failure<T>(
  status: Exclude<ToolResult<T>['status'], 'SUCCESS'>,
  errorCode: string,
  reason: string,
): ToolResult<T> {
  return {
    status,
    error_code: errorCode,
    reason,
    data: null,
  };
}

export class RobotSimulator {
  readonly #trace: BusinessTrace;
  readonly #robots: MutableRobotSnapshot[];
  readonly #tasks: MutableTaskSnapshot[];
  readonly #failures: FailureSequences;
  readonly #counters: Record<ActionName, number> = {
    restart_navigation: 0,
    force_reboot: 0,
    resume_task: 0,
  };
  readonly #cursors: { restart_navigation: number; force_reboot: number } = {
    restart_navigation: 0,
    force_reboot: 0,
  };

  constructor(options: RobotSimulatorOptions) {
    if (options.trace.runId !== options.runId) {
      throw new Error(
        `trace runId ${options.trace.runId} does not match simulator runId ${options.runId}`,
      );
    }

    const fixture = cloneFixture(options.fixture ?? DEFAULT_FIXTURE);
    this.#trace = options.trace;
    this.#robots = [...fixture.robots];
    this.#tasks = [...fixture.tasks];
    this.#failures = {
      restart_navigation: [
        ...(options.failures?.restart_navigation ??
          DEFAULT_FAILURES.restart_navigation),
      ],
      force_reboot: [
        ...(options.failures?.force_reboot ??
          DEFAULT_FAILURES.force_reboot),
      ],
    };

    this.#trace.record('simulator_initialized', null, {
      snapshot: this.snapshot(),
    });
  }

  assertTrace(trace: BusinessTrace): void {
    if (trace !== this.#trace) {
      throw new Error('simulator trace must be the same instance as services trace');
    }
  }

  getRobotStatus(
    robotId: string,
    callId: string,
  ): ToolResult<RobotSnapshot> {
    const robot = this.#robots.find((item) => item.robot_id === robotId);
    const result =
      robot === undefined
        ? failure<RobotSnapshot>(
            'FATAL_FAILURE',
            'ROBOT_NOT_FOUND',
            `robot ${robotId} was not found`,
          )
        : success(cloneRobot(robot), `robot ${robotId} status retrieved`);

    this.#trace.record('state_read', callId, {
      entity: 'robot',
      result,
    });
    return result;
  }

  getTaskStatus(taskId: string, callId: string): ToolResult<TaskSnapshot> {
    const task = this.#tasks.find((item) => item.task_id === taskId);
    const result =
      task === undefined
        ? failure<TaskSnapshot>(
            'FATAL_FAILURE',
            'TASK_NOT_FOUND',
            `task ${taskId} was not found`,
          )
        : success(cloneTask(task), `task ${taskId} status retrieved`);

    this.#trace.record('state_read', callId, {
      entity: 'task',
      result,
    });
    return result;
  }

  restartNavigation(
    robotId: string,
    callId: string,
  ): ToolResult<RobotSnapshot> {
    const robot = this.#robots.find((item) => item.robot_id === robotId);
    if (robot === undefined) {
      return failure<RobotSnapshot>(
        'FATAL_FAILURE',
        'ROBOT_NOT_FOUND',
        `robot ${robotId} was not found`,
      );
    }
    if (robot.state !== 'ERROR' || robot.error_code === null) {
      return failure<RobotSnapshot>(
        'DENIED',
        'PRECONDITION_FAILED',
        `robot ${robotId} must be in ERROR state with an active fault`,
      );
    }

    return this.#executeInjectedAction(
      'restart_navigation',
      robotId,
      callId,
      () => {
        const before = this.snapshot();
        robot.state = 'IDLE';
        robot.error_code = null;
        this.#recordStateChange('restart_navigation', callId, before);
        return cloneRobot(robot);
      },
      'navigation restarted',
    );
  }

  forceReboot(robotId: string, callId: string): ToolResult<RobotSnapshot> {
    const robot = this.#robots.find((item) => item.robot_id === robotId);
    if (robot === undefined) {
      return failure<RobotSnapshot>(
        'FATAL_FAILURE',
        'ROBOT_NOT_FOUND',
        `robot ${robotId} was not found`,
      );
    }
    if (robot.state !== 'ERROR' || robot.error_code === null) {
      return failure<RobotSnapshot>(
        'DENIED',
        'PRECONDITION_FAILED',
        `robot ${robotId} must be in ERROR state with an active fault`,
      );
    }

    return this.#executeInjectedAction(
      'force_reboot',
      robotId,
      callId,
      () => {
        let before = this.snapshot();
        robot.state = 'REBOOTING';
        this.#recordStateChange('force_reboot', callId, before);

        before = this.snapshot();
        robot.state = 'IDLE';
        robot.error_code = null;
        this.#recordStateChange('force_reboot', callId, before);
        return cloneRobot(robot);
      },
      'robot force reboot completed',
    );
  }

  resumeTask(
    robotId: string,
    taskId: string,
    callId: string,
  ): ToolResult<ResumeData> {
    const robot = this.#robots.find((item) => item.robot_id === robotId);
    if (robot === undefined) {
      return failure<ResumeData>(
        'FATAL_FAILURE',
        'ROBOT_NOT_FOUND',
        `robot ${robotId} was not found`,
      );
    }

    const task = this.#tasks.find((item) => item.task_id === taskId);
    if (task === undefined) {
      return failure<ResumeData>(
        'FATAL_FAILURE',
        'TASK_NOT_FOUND',
        `task ${taskId} was not found`,
      );
    }

    if (task.robot_id !== robotId || robot.current_task !== taskId) {
      return failure<ResumeData>(
        'DENIED',
        'BINDING_MISMATCH',
        `robot ${robotId} and task ${taskId} are not bound together`,
      );
    }

    if (
      robot.state === 'MOVING' &&
      robot.error_code === null &&
      task.status === 'RUNNING'
    ) {
      return success(
        {
          robot: cloneRobot(robot),
          task: cloneTask(task),
          already_resumed: true,
        },
        `task ${taskId} was already resumed`,
      );
    }

    if (
      robot.state !== 'IDLE' ||
      robot.error_code !== null ||
      task.status !== 'PAUSED'
    ) {
      return failure<ResumeData>(
        'DENIED',
        'PRECONDITION_FAILED',
        `robot ${robotId} must be IDLE without a fault and task ${taskId} must be PAUSED`,
      );
    }

    this.#recordActionStarted('resume_task', callId, {
      robot_id: robotId,
      task_id: taskId,
    });
    const before = this.snapshot();
    robot.state = 'MOVING';
    task.status = 'RUNNING';
    this.#recordStateChange('resume_task', callId, before);

    const result = success(
      {
        robot: cloneRobot(robot),
        task: cloneTask(task),
        already_resumed: false,
      },
      `task ${taskId} resumed`,
    );
    this.#recordActionFinished('resume_task', callId, result);
    return result;
  }

  snapshot(): SimulatorSnapshot {
    return {
      robots: this.#robots.map(cloneRobot),
      tasks: this.#tasks.map(cloneTask),
      counters: { ...this.#counters },
      cursors: { ...this.#cursors },
    };
  }

  #executeInjectedAction(
    action: InjectedActionName,
    robotId: string,
    callId: string,
    applySuccess: () => MutableRobotSnapshot,
    successReason: string,
  ): ToolResult<RobotSnapshot> {
    this.#recordActionStarted(action, callId, { robot_id: robotId });

    const sequence = this.#failures[action];
    const cursor = this.#cursors[action];
    if (cursor >= sequence.length) {
      const result = failure<RobotSnapshot>(
        'FATAL_FAILURE',
        'FAULT_SEQUENCE_EXHAUSTED',
        `${action} fault sequence exhausted`,
      );
      this.#recordActionFinished(action, callId, result);
      return result;
    }

    const outcome: ActionOutcome = sequence[cursor];
    this.#cursors[action] = cursor + 1;

    if (outcome === 'TIMEOUT') {
      const result = failure<RobotSnapshot>(
        'RETRYABLE_FAILURE',
        'TIMEOUT',
        `${action} timed out`,
      );
      this.#recordActionFinished(action, callId, result);
      return result;
    }
    if (outcome === 'FATAL') {
      const result = failure<RobotSnapshot>(
        'FATAL_FAILURE',
        'ACTION_FAILED',
        `${action} failed`,
      );
      this.#recordActionFinished(action, callId, result);
      return result;
    }

    const data = applySuccess();
    const result = success(data, successReason);
    this.#recordActionFinished(action, callId, result);
    return result;
  }

  #recordActionStarted(
    action: ActionName,
    callId: string,
    data: Record<string, unknown>,
  ): void {
    this.#trace.record('action_started', callId, {
      action,
      ...data,
    });
    this.#counters[action] += 1;
  }

  #recordActionFinished<T>(
    action: ActionName,
    callId: string,
    result: ToolResult<T>,
  ): void {
    this.#trace.record('action_finished', callId, {
      action,
      result,
    });
  }

  #recordStateChange(
    action: ActionName,
    callId: string,
    before: SimulatorSnapshot,
  ): void {
    this.#trace.record('state_changed', callId, {
      action,
      before,
      after: this.snapshot(),
    });
  }
}



