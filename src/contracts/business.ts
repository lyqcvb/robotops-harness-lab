import type { ResultStatus } from './tool-protocol.js';

export { TOOL_NAMES } from './tool-protocol.js';
export type { ResultStatus, ToolName } from './tool-protocol.js';

export const ROBOT_STATES = [
  'IDLE',
  'MOVING',
  'ERROR',
  'REBOOTING',
  'CHARGING',
  'OFFLINE',
] as const;
export const TASK_STATES = [
  'PENDING',
  'RUNNING',
  'PAUSED',
  'FAILED',
  'COMPLETED',
] as const;

export type RobotState = (typeof ROBOT_STATES)[number];
export type TaskState = (typeof TASK_STATES)[number];
export type ActionName = 'restart_navigation' | 'force_reboot' | 'resume_task';

export interface ToolResult<T = unknown> {
  readonly status: ResultStatus;
  readonly error_code: string | null;
  readonly reason: string;
  readonly data: T | null;
}

export interface RobotSnapshot {
  robot_id: string;
  state: RobotState;
  battery: number;
  error_code: string | null;
  current_task: string | null;
}

export interface TaskSnapshot {
  task_id: string;
  robot_id: string;
  status: TaskState;
}

export interface SimulatorFixture {
  readonly robots: readonly RobotSnapshot[];
  readonly tasks: readonly TaskSnapshot[];
}

export type ActionOutcome = 'SUCCESS' | 'TIMEOUT' | 'FATAL';

export interface FailureSequences {
  readonly restart_navigation: readonly ActionOutcome[];
  readonly force_reboot: readonly ActionOutcome[];
}

export interface SimulatorSnapshot {
  readonly robots: readonly RobotSnapshot[];
  readonly tasks: readonly TaskSnapshot[];
  readonly counters: Record<ActionName, number>;
  readonly cursors: {
    readonly restart_navigation: number;
    readonly force_reboot: number;
  };
}

export interface ResumeData {
  readonly robot: RobotSnapshot;
  readonly task: TaskSnapshot;
  readonly already_resumed: boolean;
}

export interface ExecutionContext {
  readonly run_id: string;
  readonly session_id: string | null;
  readonly call_id: string;
  readonly signal?: AbortSignal;
}

export interface BusinessEvent {
  readonly run_id: string;
  readonly session_id: string | null;
  readonly scenario_id: string;
  readonly seq: number;
  readonly at_ms: number;
  readonly call_id: string | null;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export const DEFAULT_FIXTURE: SimulatorFixture = {
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
};

export const DEFAULT_FAILURES: FailureSequences = {
  restart_navigation: ['TIMEOUT', 'TIMEOUT'],
  force_reboot: ['SUCCESS'],
};
