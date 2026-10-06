import type { ActionName, BusinessEvent, RobotSnapshot, SimulatorSnapshot, TaskSnapshot } from '../../contracts/business.js';
import type { RunManifest } from '../../contracts/run.js';

export type JsonRecord = Record<string, unknown>;

export interface MaintenanceTicket {
  readonly ticket_id: string;
  readonly run_id: string;
  readonly robot_id: string;
  readonly reason: string;
}

export interface EvaluateRunInput {
  readonly manifest: RunManifest;
  readonly events: readonly BusinessEvent[];
  readonly nativeEvents: readonly unknown[];
}

export interface EventView {
  readonly index: number;
  readonly type: string;
  readonly data: JsonRecord;
  readonly callId: string | null;
  readonly sessionId: string | null;
  readonly atMs: number;
  readonly seq: number;
}

export interface NativeView {
  readonly index: number;
  readonly type: string;
  readonly data: JsonRecord;
}

export interface NativeToolCallView {
  readonly index: number;
  readonly name: string | null;
  readonly args: JsonRecord | null;
}

export interface TicketEventView {
  readonly index: number;
  readonly type: 'ticket_created' | 'ticket_reused';
  readonly ticket: MaintenanceTicket;
}

export interface ApprovalBinding {
  readonly run_id: string;
  readonly session_id: string;
  readonly call_id: string;
  readonly action: 'force_reboot';
  readonly canonical_args: string;
  readonly precondition_hash: string;
}

export interface ApprovalPending {
  readonly index: number;
  readonly atMs: number;
  readonly binding: ApprovalBinding;
  readonly deadlineMs: number;
}

export interface ApprovalDecision {
  readonly index: number;
  readonly callId: string | null;
  readonly atMs: number;
  readonly binding: ApprovalBinding;
  readonly decision: 'approved' | 'rejected' | 'cancelled';
  readonly source: 'manual' | 'scripted';
}

export interface ApprovalConsumed {
  readonly index: number;
  readonly atMs: number;
  readonly binding: ApprovalBinding;
  readonly source: 'manual' | 'scripted';
  readonly nativeApproved: true;
}

export interface ToolResultView {
  readonly status: 'SUCCESS' | 'RETRYABLE_FAILURE' | 'FATAL_FAILURE' | 'DENIED';
  readonly error_code: string | null;
  readonly reason: string;
  readonly data: unknown;
}

export interface ToolRequestView {
  readonly index: number;
  readonly callId: string | null;
  readonly toolName: string;
  readonly args: JsonRecord;
  readonly requestCount: number;
  readonly consumed: boolean;
}

export interface HandlerView {
  readonly index: number;
  readonly callId: string | null;
  readonly toolName: string;
  readonly args: JsonRecord;
}

export interface ActionStartView {
  readonly index: number;
  readonly atMs: number;
  readonly callId: string;
  readonly action: ActionName;
  readonly robotId: string;
  readonly taskId: string | null;
  readonly args: JsonRecord;
  readonly preconditionRobot: RobotSnapshot | null;
  readonly preconditionTask: TaskSnapshot | null;
  readonly preconditionHash: string;
}

export interface ActionFinishView {
  readonly index: number;
  readonly atMs: number;
  readonly callId: string;
  readonly action: ActionName;
  readonly result: ToolResultView;
}

export interface StateChangeView {
  readonly index: number;
  readonly callId: string;
  readonly action: ActionName;
  readonly before: SimulatorSnapshot;
  readonly after: SimulatorSnapshot;
}

export interface StateReadView {
  readonly index: number;
  readonly callId: string;
  readonly entity: 'robot' | 'task';
  readonly result: ToolResultView;
}

export interface ActionRecord {
  readonly start: ActionStartView;
  finish: ActionFinishView | null;
  readonly changes: StateChangeView[];
}

export interface TerminalView {
  readonly index: number;
  readonly runtimeStatus: 'COMPLETE' | 'ERROR' | 'CANCELLED' | 'BLOCKED';
  readonly simulator: SimulatorSnapshot;
  readonly tickets: readonly MaintenanceTicket[];
  readonly activeMs: number | null;
  readonly approvalWaitMs: number | null;
}

export interface MutableSimulatorSnapshot {
  robots: RobotSnapshot[];
  tasks: TaskSnapshot[];
  counters: Record<ActionName, number>;
  cursors: {
    restart_navigation: number;
    force_reboot: number;
  };
}

export interface NativeApprovalAsked {
  readonly index: number;
  readonly id: string;
  readonly callId: string;
  readonly toolName: string;
}

export interface NativeApprovalDecision {
  readonly index: number;
  readonly id: string;
  readonly outcome: string;
}

export interface ScenarioExpectationInput {
  readonly manifest: RunManifest;
  readonly runStoppedViews: readonly EventView[];
  readonly actionExecutions: Readonly<Record<ActionName, number>>;
  readonly taskSuccess: boolean;
  readonly restartSuccesses: readonly ActionRecord[];
  readonly restartTimeouts: readonly ActionRecord[];
  readonly forceSuccesses: readonly ActionRecord[];
  readonly pendingApprovalCount: number;
  readonly rejectedDecisions: readonly ApprovalDecision[];
  readonly nativeRejectedEvidence: boolean;
  readonly oneTicket: boolean;
  readonly finalFailureState: boolean;
  readonly sopNotFound: boolean;
}
