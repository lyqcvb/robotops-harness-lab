import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';

import type {
  BusinessApprovalRequest,
  BusinessRuntimeInput,
  PendingApproval,
} from './runtime-types.js';
import { denied, MAX_TIMER_MS, safeError } from './runtime-support.js';

type DecisionOutcome = 'approved' | 'rejected' | 'cancelled' | 'timeout';

function raceApprovalDecision(
  deadline: number,
  signal: AbortSignal,
  operation: () => Promise<'approved' | 'rejected' | 'cancelled'>,
): Promise<DecisionOutcome> {
  if (signal.aborted) return Promise.resolve<DecisionOutcome>('cancelled');
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.resolve<DecisionOutcome>('timeout');
  return new Promise<DecisionOutcome>((resolve, reject) => {
    let settled = false;
    const timer: { value: NodeJS.Timeout | undefined } = { value: undefined };
    const settle = (outcome: DecisionOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer.value !== undefined) clearTimeout(timer.value);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => {
      settle('cancelled');
    };
    timer.value = setTimeout(() => {
      settle('timeout');
    }, Math.min(remaining, MAX_TIMER_MS));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void operation().then(
      (outcome) => {
        settle(outcome);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer.value);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export function createApprovalHandler({
  input,
  pendingApprovals,
  armActiveTimer,
}: {
  readonly input: BusinessRuntimeInput;
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly armActiveTimer: () => void;
}): (req: ApprovalRequest) => Promise<ApprovalOutcome> {
  const runId = input.runId;

  const recordDeniedApproval = (pending: PendingApproval, code: string, reason: string): void => {
    input.trace.record('tool_result', pending.callId, {
      tool_name: 'force_reboot',
      result: denied(code, reason),
      phase: 'approval',
    });
  };

  return async (req: ApprovalRequest): Promise<ApprovalOutcome> => {
    const callId = req.callId === undefined ? '' : String(req.callId);
    const sessionId = String(req.agent.id);
    const pending = callId === '' ? undefined : pendingApprovals.get(callId);
    if (
      pending === undefined
      || req.toolName !== 'force_reboot'
      || pending.sessionId !== sessionId
      || pending.runId !== runId
    ) {
      input.trace.record('approval_unmatched', callId, {
        tool_name: req.toolName,
        reason: 'approval request does not match a pending force_reboot call',
      });
      return 'rejected';
    }

    const source = input.approval?.source ?? 'scripted';
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (req.signal?.aborted === true || input.signal?.aborted === true) controller.abort();

    try {
      if (input.approval === undefined) {
        input.ledger.decide(callId, 'cancelled', source);
        recordDeniedApproval(pending, 'APPROVAL_UNAVAILABLE', 'no approval channel is available');
        input.trace.record('approval_unavailable', callId, { action: 'force_reboot' });
        input.boundary.stop('APPROVAL_UNAVAILABLE');
        return 'unavailable';
      }

      const request: BusinessApprovalRequest = {
        run_id: pending.runId,
        session_id: pending.sessionId ?? '',
        call_id: pending.callId,
        action: 'force_reboot',
        args: { ...pending.args },
        deadline_ms: pending.deadline,
      };
      const outcome = await raceApprovalDecision(
        pending.deadline,
        controller.signal,
        () => input.approval!.decide(request, controller.signal),
      );

      if (outcome === 'approved') {
        if (!input.ledger.decide(callId, 'approved', source)) {
          recordDeniedApproval(pending, 'APPROVAL_INVALID', 'approval binding is no longer valid');
          input.boundary.stop('APPROVAL_REJECTED');
          return 'rejected';
        }
        return 'allowed-once';
      }

      if (outcome === 'rejected') {
        input.ledger.decide(callId, 'rejected', source);
        recordDeniedApproval(pending, 'APPROVAL_REJECTED', 'force_reboot approval was rejected');
        // A rejection is a soft stop: robot actions end, the model may still write a ticket.
        input.boundary.stop('APPROVAL_REJECTED');
        return 'rejected';
      }

      input.ledger.decide(callId, 'cancelled', source);
      if (outcome === 'timeout') {
        recordDeniedApproval(pending, 'APPROVAL_TIMEOUT', 'force_reboot approval deadline expired');
        input.trace.record('approval_timeout', callId, { action: 'force_reboot' });
      } else {
        recordDeniedApproval(pending, 'APPROVAL_CANCELLED', 'force_reboot approval was cancelled');
      }
      input.boundary.stop('APPROVAL_CANCELLED');
      return 'cancelled';
    } catch (error) {
      const details = safeError(error);
      input.ledger.decide(callId, 'cancelled', source);
      recordDeniedApproval(pending, 'APPROVAL_ERROR', `approval channel failed: ${details.message}`);
      input.trace.record('runtime_error', callId, {
        phase: 'approval',
        error: { name: details.name, message: details.message, code: details.code },
      });
      input.boundary.stop('APPROVAL_CANCELLED');
      return 'cancelled';
    } finally {
      pendingApprovals.delete(callId);
      // Withdraw any still-pending external decision before releasing the wait.
      if (!controller.signal.aborted) controller.abort();
      req.signal?.removeEventListener('abort', onAbort);
      input.signal?.removeEventListener('abort', onAbort);
      input.boundary.resumeAfterApproval();
      armActiveTimer();
    }
  };
}
