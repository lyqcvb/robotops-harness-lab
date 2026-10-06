import type { ExecutionContext } from '../contracts/business.js';
import type { BusinessTrace } from '../trace/business-trace.js';
import { canonicalJson } from '../contracts/canonical-json.js';
import { DEFAULT_BUDGETS } from '../contracts/policy.js';

export type ApprovalSource = 'manual' | 'scripted';
export type ApprovalOutcome = 'approved' | 'rejected' | 'cancelled';
export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'consumed';

export interface ApprovalBinding {
  readonly run_id: string;
  readonly session_id: string | null;
  readonly call_id: string;
  readonly action: 'force_reboot';
  readonly canonical_args: string;
  readonly precondition_hash: string;
}

export interface ApprovalLedgerRecord {
  readonly binding: ApprovalBinding;
  readonly status: ApprovalStatus;
  readonly source: ApprovalSource | null;
  readonly requested_at_ms: number;
  readonly deadline_ms: number;
  readonly decided_at_ms: number | null;
  readonly consumed_at_ms: number | null;
  readonly reason: string | null;
}

type MutableApprovalLedgerRecord = {
  -readonly [Key in keyof ApprovalLedgerRecord]: ApprovalLedgerRecord[Key];
};

interface ApprovalLedgerOptions {
  readonly runId: string;
  readonly trace: BusinessTrace;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly allowScripted?: boolean;
}

function cloneBinding(binding: ApprovalBinding): ApprovalBinding {
  return { ...binding };
}

function cloneRecord(record: ApprovalLedgerRecord): ApprovalLedgerRecord {
  return {
    ...record,
    binding: cloneBinding(record.binding),
  };
}

function isValidSource(value: unknown): value is ApprovalSource {
  return value === 'manual' || value === 'scripted';
}

function isValidOutcome(value: unknown): value is ApprovalOutcome {
  return value === 'approved' || value === 'rejected' || value === 'cancelled';
}

export class ApprovalLedger {
  readonly #runId: string;
  readonly #trace: BusinessTrace;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #allowScripted: boolean;
  readonly #records: MutableApprovalLedgerRecord[] = [];

  constructor(options: ApprovalLedgerOptions) {
    if (options.trace.runId !== options.runId) {
      throw new Error(
        `trace runId ${options.trace.runId} does not match ledger runId ${options.runId}`,
      );
    }

    this.#runId = options.runId;
    this.#trace = options.trace;
    this.#now = options.now ?? (() => performance.now());
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_BUDGETS.approvalMs;
    this.#allowScripted = options.allowScripted ?? false;

    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs < 0) {
      throw new TypeError('timeoutMs must be a finite non-negative number');
    }
    this.#readNow();
  }

  request(
    ctx: ExecutionContext,
    args: Record<string, string>,
    fingerprint: string,
  ): ApprovalBinding | null {
    if (
      ctx.run_id !== this.#runId ||
      ctx.session_id !== this.#trace.sessionId ||
      typeof ctx.call_id !== 'string' ||
      ctx.call_id.trim().length === 0
    ) {
      this.#recordInvalid(null, 'context_mismatch');
      return null;
    }
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
      this.#recordInvalid(null, 'missing_precondition_hash');
      return null;
    }

    let canonicalArgs: string;
    try {
      canonicalArgs = canonicalJson(args);
    } catch {
      this.#recordInvalid(null, 'invalid_arguments');
      return null;
    }

    if (this.#recordForCall(ctx.call_id) !== null) {
      this.#recordInvalid(null, 'duplicate_or_replayed_call');
      return null;
    }

    const now = this.#readNow();
    const binding: ApprovalBinding = {
      run_id: this.#runId,
      session_id: this.#trace.sessionId,
      call_id: ctx.call_id,
      action: 'force_reboot',
      canonical_args: canonicalArgs,
      precondition_hash: fingerprint,
    };
    const deadlineMs = now + this.#timeoutMs;
    const record: MutableApprovalLedgerRecord = {
      binding,
      status: 'pending',
      source: null,
      requested_at_ms: now,
      deadline_ms: deadlineMs,
      decided_at_ms: null,
      consumed_at_ms: null,
      reason: null,
    };
    this.#records.push(record);
    this.#trace.record('approval_pending', ctx.call_id, {
      binding: cloneBinding(binding),
      deadline_ms: deadlineMs,
    });
    return cloneBinding(binding);
  }

  decide(
    callId: string,
    outcome: ApprovalOutcome,
    source: ApprovalSource,
  ): boolean {
    const record = this.#recordForCall(callId);
    if (record === null || record.status !== 'pending') {
      this.#recordInvalid(record, 'no_pending_approval');
      return false;
    }
    if (this.#expireIfNeeded(record)) return false;
    if (!isValidOutcome(outcome) || !isValidSource(source)) {
      this.#recordInvalid(record, 'invalid_decision_or_source');
      return false;
    }
    if (source === 'scripted' && !this.#allowScripted) {
      this.#recordInvalid(record, 'scripted_approval_not_enabled');
      return false;
    }

    record.status = outcome;
    record.source = source;
    record.decided_at_ms = this.#readNow();
    record.reason = null;
    this.#trace.record('approval_decided', callId, {
      binding: cloneBinding(record.binding),
      decision: outcome,
      source,
    });
    return true;
  }

  consume(
    ctx: ExecutionContext,
    args: Record<string, string>,
    fingerprint: string,
    nativeApproved: boolean,
  ): boolean {
    const record = this.#recordForCall(ctx.call_id);
    if (record === null) {
      const mismatched = this.#candidateForMismatchedCall(
        ctx,
        args,
        fingerprint,
      );
      if (mismatched !== null) {
        this.#terminateGrant(mismatched, 'call_mismatch');
        return false;
      }
      this.#recordInvalid(null, 'unknown_call');
      return false;
    }
    if (this.#expireIfNeeded(record)) return false;
    if (record.status !== 'approved') {
      this.#recordInvalid(record, `approval_${record.status}`);
      return false;
    }
    if (
      ctx.run_id !== record.binding.run_id ||
      ctx.session_id !== record.binding.session_id
    ) {
      this.#terminateGrant(record, 'run_or_session_mismatch');
      return false;
    }

    let canonicalArgs: string;
    try {
      canonicalArgs = canonicalJson(args);
    } catch {
      this.#terminateGrant(record, 'invalid_arguments');
      return false;
    }
    if (canonicalArgs !== record.binding.canonical_args) {
      this.#terminateGrant(record, 'canonical_args_mismatch');
      return false;
    }
    if (
      fingerprint !== record.binding.precondition_hash ||
      record.binding.action !== 'force_reboot'
    ) {
      this.#terminateGrant(record, 'precondition_or_action_mismatch');
      return false;
    }
    if (nativeApproved !== true) {
      this.#terminateGrant(record, 'native_approval_missing');
      return false;
    }

    record.status = 'consumed';
    record.consumed_at_ms = this.#readNow();
    this.#trace.record('approval_consumed', ctx.call_id, {
      binding: cloneBinding(record.binding),
      source: record.source,
      native_approved: true,
    });
    return true;
  }
  cancelAll(reason: string): void {
    const atMs = this.#readNow();
    for (const record of this.#records) {
      if (record.status !== 'pending' && record.status !== 'approved') continue;
      record.status = 'cancelled';
      record.decided_at_ms = atMs;
      record.reason = reason;
      this.#trace.record('approval_cancelled', record.binding.call_id, {
        binding: cloneBinding(record.binding),
        reason,
      });
    }
  }

  records(): readonly ApprovalLedgerRecord[] {
    return this.#records.map(cloneRecord);
  }

  #recordForCall(callId: string): MutableApprovalLedgerRecord | null {
    return (
      [...this.#records]
        .reverse()
        .find((record) => record.binding.call_id === callId) ?? null
    );
  }

  #candidateForMismatchedCall(
    ctx: ExecutionContext,
    args: Record<string, string>,
    fingerprint: string,
  ): MutableApprovalLedgerRecord | null {
    let canonicalArgs: string;
    try {
      canonicalArgs = canonicalJson(args);
    } catch {
      return null;
    }

    const candidates = this.#records.filter(
      (record) =>
        record.status === 'approved' &&
        record.binding.run_id === ctx.run_id &&
        record.binding.session_id === ctx.session_id &&
        record.binding.canonical_args === canonicalArgs &&
        record.binding.precondition_hash === fingerprint,
    );
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  }

  #terminateGrant(
    record: MutableApprovalLedgerRecord,
    reason: string,
  ): void {
    record.status = 'expired';
    record.reason = reason;
    record.decided_at_ms = this.#readNow();
    this.#recordInvalid(record, reason);
  }

  #expireIfNeeded(record: MutableApprovalLedgerRecord): boolean {
    if (record.status !== 'pending' && record.status !== 'approved') return false;
    if (this.#readNow() < record.deadline_ms) return false;

    record.status = 'expired';
    record.reason = 'timeout';
    record.decided_at_ms = this.#readNow();
    this.#trace.record('approval_expired', record.binding.call_id, {
      binding: cloneBinding(record.binding),
      deadline_ms: record.deadline_ms,
    });
    return true;
  }

  #recordInvalid(record: MutableApprovalLedgerRecord | null, reason: string): void {
    this.#trace.record('approval_invalid', record?.binding.call_id ?? null, {
      binding: record === null ? null : cloneBinding(record.binding),
      reason,
    });
  }

  #readNow(): number {
    const value = this.#now();
    if (!Number.isFinite(value)) {
      throw new TypeError('now() must return a finite monotonic timestamp');
    }
    return value;
  }
}