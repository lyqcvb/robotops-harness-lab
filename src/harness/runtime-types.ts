import type { ScenarioId } from '../contracts/run.js';
import type { ScriptedTurn } from '../contracts/probe.js';
import type { ApprovalLedger } from '../tools/approval-ledger.js';
import type { ToolBoundary } from '../tools/tool-boundary.js';
import type { BusinessTrace } from '../trace/business-trace.js';

export interface SafeError {
  readonly name: string;
  readonly message: string;
  readonly code: string | null;
}

export interface PendingApproval {
  readonly runId: string;
  readonly sessionId: string | null;
  readonly callId: string;
  readonly args: Record<string, string>;
  readonly fingerprint: string;
  /** Monotonic (performance.now) deadline shared with the ledger record. */
  readonly deadline: number;
}

export interface BusinessApprovalRequest {
  readonly run_id: string;
  readonly session_id: string;
  readonly call_id: string;
  readonly action: 'force_reboot';
  readonly args: Record<string, string>;
  readonly deadline_ms: number;
}

export interface BusinessRuntimeApproval {
  readonly source: 'manual' | 'scripted';
  readonly decide: (
    request: BusinessApprovalRequest,
    signal: AbortSignal,
  ) => Promise<'approved' | 'rejected' | 'cancelled'>;
}

export interface BusinessRuntimeInput {
  readonly projectRoot: string;
  readonly runId: string;
  readonly scenarioId: ScenarioId;
  readonly mode: 'offline' | 'live';
  readonly model: string;
  readonly prompt: string;
  readonly turns: readonly ScriptedTurn[];
  readonly trace: BusinessTrace;
  readonly boundary: ToolBoundary;
  readonly ledger: ApprovalLedger;
  readonly nativeEvents: unknown[];
  readonly approval?: BusinessRuntimeApproval;
  readonly signal?: AbortSignal;
}

export interface BusinessRuntimeResult {
  readonly status: 'COMPLETE' | 'ERROR' | 'CANCELLED' | 'BLOCKED';
  readonly session_id: string | null;
  readonly persisted_event_count: number;
  readonly error: SafeError | null;
}
