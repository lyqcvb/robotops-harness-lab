import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';

import type {
  BusinessApprovalRequest,
  BusinessRuntimeInput,
  PendingApproval,
} from './runtime-types.js';
import { denied, MAX_TIMER_MS, safeError, type BlockCall } from './runtime-support.js';

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
  blockCall,
}: {
  readonly input: BusinessRuntimeInput;
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly armActiveTimer: () => void;
  readonly blockCall: BlockCall;
}): (req: ApprovalRequest) => Promise<ApprovalOutcome> {
  const runId = input.runId;

  // Each outcome states why force_reboot did not run and what the run still allows, so the
  // model can tell a human "no" from an expired, withdrawn or broken approval.
  const recordDeniedApproval = (pending: PendingApproval, code: string, reason: string): void => {
    blockCall(pending.callId, 'force_reboot', 'approval', denied(code, reason));
  };
  const SOFT_STOP_NOTE = 'Robot actions are disabled for the rest of this run; status reads, SOP lookup and maintenance tickets remain available.';
  const HARD_STOP_NOTE = 'The run is stopped; no further tool calls will be accepted.';

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
      if (callId !== '') {
        blockCall(callId, String(req.toolName), 'approval', denied(
          'APPROVAL_UNMATCHED',
          'The approval request did not match a pending force_reboot call for this run and session, so it was rejected.',
        ));
      }
      if (pending !== undefined) {
        // pre-execute already paused the active clock for this call; withdraw the grant and
        // restart the clock, or the active deadline would stay disarmed for the rest of the run.
        input.ledger.cancel(callId, 'approval request did not match the pending call');
        pendingApprovals.delete(callId);
        input.boundary.resumeAfterApproval();
        armActiveTimer();
      }
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
        // No channel means no decision source; cancel without attributing one.
        input.ledger.cancel(callId, 'approval channel unavailable');
        recordDeniedApproval(
          pending,
          'APPROVAL_UNAVAILABLE',
          `No approval channel is configured for this run, so nobody can approve force_reboot. ${SOFT_STOP_NOTE}`,
        );
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
          recordDeniedApproval(
            pending,
            'APPROVAL_INVALID',
            `An approval arrived, but its one-time binding no longer matches this call (already used, cancelled or expired), so it was treated as a rejection. ${SOFT_STOP_NOTE}`,
          );
          input.boundary.stop('APPROVAL_REJECTED');
          return 'rejected';
        }
        return 'allowed-once';
      }

      if (outcome === 'rejected') {
        input.ledger.decide(callId, 'rejected', source);
        recordDeniedApproval(pending, 'APPROVAL_REJECTED', `The approver rejected force_reboot. ${SOFT_STOP_NOTE}`);
        // A rejection is a soft stop: robot actions end, the model may still write a ticket.
        input.boundary.stop('APPROVAL_REJECTED');
        return 'rejected';
      }

      input.ledger.decide(callId, 'cancelled', source);
      if (outcome === 'timeout') {
        recordDeniedApproval(
          pending,
          'APPROVAL_TIMEOUT',
          `No approval decision arrived before the approval deadline, so the request expired. ${HARD_STOP_NOTE}`,
        );
        input.trace.record('approval_timeout', callId, { action: 'force_reboot' });
      } else if (controller.signal.aborted) {
        recordDeniedApproval(
          pending,
          'APPROVAL_CANCELLED',
          `The approval request was withdrawn because the run was cancelled before a decision arrived. ${HARD_STOP_NOTE}`,
        );
      } else {
        recordDeniedApproval(
          pending,
          'APPROVAL_CANCELLED',
          `The approver cancelled the request without approving or rejecting it. ${HARD_STOP_NOTE}`,
        );
      }
      input.boundary.stop('APPROVAL_CANCELLED');
      return 'cancelled';
    } catch (error) {
      const details = safeError(error);
      input.ledger.decide(callId, 'cancelled', source);
      recordDeniedApproval(
        pending,
        'APPROVAL_ERROR',
        `The approval channel failed before returning a decision (${details.message}). ${HARD_STOP_NOTE}`,
      );
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
