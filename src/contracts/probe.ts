import type { GateStatus } from './probe-evidence.js';

export interface SafeError {
  readonly type: string;
  readonly name: string;
  readonly code: string | null;
  readonly message: string;
}

export interface ScriptedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type ScriptedTurn =
  | { readonly kind: 'tool-calls'; readonly calls: readonly ScriptedToolCall[] }
  | { readonly kind: 'text'; readonly text: string };

export type ProbeApprovalMode = 'unavailable' | 'rejected' | 'approve-once' | 'cancelled' | 'expire';
export type ProbePolicyFixture = 'default' | 'allow-force';

export interface ProbeBudgets {
  readonly modelRequests: number;
  readonly toolCalls: number;
  readonly activeMs: number;
  readonly approvalMs: number;
}

export interface ProbeCaseDefinition {
  readonly id: string;
  readonly prompt: string;
  readonly turns: readonly ScriptedTurn[];
  readonly approvalMode: ProbeApprovalMode;
  readonly policyFixture?: ProbePolicyFixture;
  readonly restrictToReadOnly?: boolean;
  readonly budgets?: Partial<ProbeBudgets>;
}

export interface ProbeCaseResult {
  readonly id: string;
  readonly status: GateStatus;
  readonly modelRequests: number;
  readonly toolRequests: number;
  readonly actionExecutions: number;
  readonly approvalAsked: number;
  readonly approvalAllowedOnce: number;
  readonly executionsByName: Readonly<Record<string, number>>;
  readonly sessionId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly toolNames: readonly string[];
  readonly persistedEventCount: number;
  readonly nativeEvents: readonly unknown[];
  readonly probeEvents: readonly unknown[];
  readonly notes: readonly string[];
  readonly error: SafeError | null;
}

export interface ProbeExecutionResult {
  readonly cases: readonly ProbeCaseResult[];
  readonly nativeEvents: readonly unknown[];
  readonly probeEvents: readonly unknown[];
  readonly toolNames: readonly string[];
  readonly counters: {
    readonly modelRequests: number;
    readonly toolRequests: number;
    readonly actionExecutions: number;
    readonly approvalAsked: number;
    readonly approvalAllowedOnce: number;
  };
}

export interface LiveSmokeResult extends ProbeCaseResult {
  readonly liveCalledGetRobotStatus: boolean;
  readonly liveToolResultReadable: boolean;
}
