import type {
  ExecutionContext,
  ResumeData,
  ResultStatus,
  RobotSnapshot,
  SimulatorSnapshot,
  TaskSnapshot,
  ToolName,
  ToolResult,
} from '../contracts/business.js';
import type { BusinessTrace } from '../trace/business-trace.js';
import { RobotSimulator } from '../simulator/robot-simulator.js';

function assertNonEmpty(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
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
  status: Exclude<ResultStatus, 'SUCCESS'>,
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

const NAV_042_SOP = {
  error_code: 'NAV_042',
  title: 'NAV_042 navigation fault recovery',
  steps: [
    '验证机器人任务双向绑定',
    '最多两次 restart 并读取成功状态',
    '连续失败申请 force 批准',
    'force 后读 IDLE/no fault',
    'resume 后读 robot/task',
  ],
} as const;

export class RobotService {
  readonly #simulator: RobotSimulator;

  constructor(simulator: RobotSimulator) {
    this.#simulator = simulator;
  }

  getRobotStatus(
    robotId: string,
    callId: string,
  ): ToolResult<RobotSnapshot> {
    assertNonEmpty(robotId, 'robotId');
    assertNonEmpty(callId, 'callId');
    return this.#simulator.getRobotStatus(robotId, callId);
  }

  getTaskStatus(
    taskId: string,
    callId: string,
  ): ToolResult<TaskSnapshot> {
    assertNonEmpty(taskId, 'taskId');
    assertNonEmpty(callId, 'callId');
    return this.#simulator.getTaskStatus(taskId, callId);
  }

  restartNavigation(
    robotId: string,
    callId: string,
  ): ToolResult<RobotSnapshot> {
    assertNonEmpty(robotId, 'robotId');
    assertNonEmpty(callId, 'callId');
    return this.#simulator.restartNavigation(robotId, callId);
  }

  forceReboot(
    robotId: string,
    callId: string,
  ): ToolResult<RobotSnapshot> {
    assertNonEmpty(robotId, 'robotId');
    assertNonEmpty(callId, 'callId');
    return this.#simulator.forceReboot(robotId, callId);
  }

  resumeTask(
    robotId: string,
    taskId: string,
    callId: string,
  ): ToolResult<ResumeData> {
    assertNonEmpty(robotId, 'robotId');
    assertNonEmpty(taskId, 'taskId');
    assertNonEmpty(callId, 'callId');
    return this.#simulator.resumeTask(robotId, taskId, callId);
  }
}

export class SOPService {
  searchSop(errorCode: string): ToolResult {
    assertNonEmpty(errorCode, 'errorCode');

    if (errorCode !== NAV_042_SOP.error_code) {
      return failure(
        'FATAL_FAILURE',
        'SOP_NOT_FOUND',
        `SOP for error code ${errorCode} was not found`,
      );
    }

    return success(
      {
        error_code: NAV_042_SOP.error_code,
        title: NAV_042_SOP.title,
        steps: [...NAV_042_SOP.steps],
      },
      `SOP for error code ${errorCode} retrieved`,
    );
  }
}

export interface MaintenanceTicket {
  readonly ticket_id: string;
  readonly run_id: string;
  readonly robot_id: string;
  readonly reason: string;
}

function cloneTicket(ticket: MaintenanceTicket): MaintenanceTicket {
  return { ...ticket };
}

export class TicketService {
  readonly #runId: string;
  readonly #trace: BusinessTrace;
  readonly #tickets: MaintenanceTicket[] = [];
  readonly #ticketsByKey = new Map<string, MaintenanceTicket>();
  #nextNumber = 1;

  constructor(runId: string, trace: BusinessTrace) {
    assertNonEmpty(runId, 'runId');
    if (trace.runId !== runId) {
      throw new Error(
        `trace runId ${trace.runId} does not match ticket runId ${runId}`,
      );
    }

    this.#runId = runId;
    this.#trace = trace;
  }

  create(
    robotId: string,
    reason: string,
    callId: string,
  ): ToolResult<MaintenanceTicket> {
    assertNonEmpty(robotId, 'robotId');
    assertNonEmpty(reason, 'reason');
    assertNonEmpty(callId, 'callId');

    const key = JSON.stringify([this.#runId, robotId, reason]);
    if (key === undefined) {
      throw new Error('failed to serialize maintenance ticket identity');
    }

    const existing = this.#ticketsByKey.get(key);
    if (existing !== undefined) {
      const ticket = cloneTicket(existing);
      this.#trace.record('ticket_reused', callId, { ticket });
      return success(ticket, `maintenance ticket ${ticket.ticket_id} reused`);
    }

    const ticket: MaintenanceTicket = {
      ticket_id: `${this.#runId}-${this.#nextNumber}`,
      run_id: this.#runId,
      robot_id: robotId,
      reason,
    };
    this.#nextNumber += 1;
    this.#tickets.push(ticket);
    this.#ticketsByKey.set(key, ticket);

    const resultTicket = cloneTicket(ticket);
    this.#trace.record('ticket_created', callId, {
      ticket: resultTicket,
    });
    return success(
      resultTicket,
      `maintenance ticket ${ticket.ticket_id} created`,
    );
  }

  list(): MaintenanceTicket[] {
    return this.#tickets.map(cloneTicket);
  }
}

export interface ServicePort {
  invoke(
    name: ToolName,
    args: Record<string, string>,
    ctx: ExecutionContext,
  ): ToolResult | Promise<ToolResult>;
  snapshot(): {
    simulator: SimulatorSnapshot;
    tickets: MaintenanceTicket[];
  };
}

export class BusinessServices implements ServicePort {
  readonly #runId: string;
  readonly #simulator: RobotSimulator;
  readonly #trace: BusinessTrace;
  readonly #robotService: RobotService;
  readonly #sopService: SOPService;
  readonly #ticketService: TicketService;

  constructor(options: {
    readonly runId: string;
    readonly simulator: RobotSimulator;
    readonly trace: BusinessTrace;
  }) {
    assertNonEmpty(options.runId, 'runId');
    if (options.trace.runId !== options.runId) {
      throw new Error(
        `trace runId ${options.trace.runId} does not match services runId ${options.runId}`,
      );
    }

    options.simulator.assertTrace(options.trace);

    this.#runId = options.runId;
    this.#simulator = options.simulator;
    this.#trace = options.trace;
    this.#robotService = new RobotService(options.simulator);
    this.#sopService = new SOPService();
    this.#ticketService = new TicketService(options.runId, options.trace);
  }

  invoke(
    name: ToolName,
    args: Record<string, string>,
    ctx: ExecutionContext,
  ): ToolResult {
    assertNonEmpty(ctx.call_id, 'ctx.call_id');
    this.#trace.record('service_called', ctx.call_id, {
      tool_name: name,
      args,
    });

    let result: ToolResult;
    if (ctx.run_id !== this.#runId) {
      result = failure(
        'DENIED',
        'CONTEXT_MISMATCH',
        `context run_id ${ctx.run_id} does not match service run_id ${this.#runId}`,
      );
    } else {
      result = this.#invokeForRun(name, args, ctx);
    }

    this.#trace.record('service_result', ctx.call_id, {
      tool_name: name,
      result,
    });
    return result;
  }

  snapshot(): {
    simulator: SimulatorSnapshot;
    tickets: MaintenanceTicket[];
  } {
    return {
      simulator: this.#simulator.snapshot(),
      tickets: this.#ticketService.list(),
    };
  }

  #invokeForRun(
    name: ToolName,
    args: Record<string, string>,
    ctx: ExecutionContext,
  ): ToolResult {
    switch (name) {
      case 'get_robot_status':
        return this.#robotService.getRobotStatus(args.robot_id, ctx.call_id);
      case 'get_task_status':
        return this.#robotService.getTaskStatus(args.task_id, ctx.call_id);
      case 'search_sop':
        return this.#sopService.searchSop(args.error_code);
      case 'restart_navigation':
        return this.#robotService.restartNavigation(args.robot_id, ctx.call_id);
      case 'force_reboot':
        return this.#robotService.forceReboot(args.robot_id, ctx.call_id);
      case 'resume_task':
        return this.#robotService.resumeTask(
          args.robot_id,
          args.task_id,
          ctx.call_id,
        );
      case 'create_maintenance_ticket': {
        assertNonEmpty(args.robot_id, 'robot_id');
        assertNonEmpty(args.reason, 'reason');
        const robotExists = this.#simulator
          .snapshot()
          .robots.some((robot) => robot.robot_id === args.robot_id);
        if (!robotExists) {
          return failure(
            'FATAL_FAILURE',
            'ROBOT_NOT_FOUND',
            `robot ${args.robot_id} was not found`,
          );
        }

        return this.#ticketService.create(
          args.robot_id,
          args.reason,
          ctx.call_id,
        );
      }
      default:
        return failure(
          'FATAL_FAILURE',
          'UNKNOWN_TOOL',
          `tool ${String(name)} is not supported`,
        );
    }
  }
}


