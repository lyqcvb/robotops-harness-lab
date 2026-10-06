import type { ScenarioExpectationInput } from './types.js';
import { normalizeStopReason } from './evidence-parsers.js';

export function evaluateScenarioExpectation(input: ScenarioExpectationInput): boolean {
  const {
    manifest,
    runStoppedViews,
    actionExecutions,
    taskSuccess,
    restartSuccesses,
    restartTimeouts,
    forceSuccesses,
    pendingApprovalCount,
    rejectedDecisions,
    nativeRejectedEvidence,
    oneTicket,
    finalFailureState,
    sopNotFound,
  } = input;
  const stopReasons = runStoppedViews
    .map((stopped) => typeof stopped.data.reason === 'string' ? normalizeStopReason(stopped.data.reason) : '')
    .filter((reason) => reason.length > 0);
  const hasSingleStopReason = (reason: string): boolean => stopReasons.length === 1 && stopReasons[0] === reason;

  switch (manifest.scenario_id) {
    case 'happy_path':
      return (
        runStoppedViews.length === 0 &&
        actionExecutions.restart_navigation === 0 &&
        actionExecutions.force_reboot === 0 &&
        actionExecutions.resume_task === 1 &&
        taskSuccess
      );
    case 'navigation_restart_success':
      return (
        runStoppedViews.length === 0 &&
        actionExecutions.restart_navigation === 1 &&
        restartSuccesses.length === 1 &&
        actionExecutions.force_reboot === 0 &&
        taskSuccess
      );
    case 'navigation_restart_fail_then_reboot':
      return manifest.config === 'full'
        ? runStoppedViews.length === 0 &&
          actionExecutions.restart_navigation === 2 &&
          restartTimeouts.length === 2 &&
          actionExecutions.force_reboot === 1 &&
          forceSuccesses.length === 1 &&
          taskSuccess
        : manifest.config === 'fail-fast' &&
          hasSingleStopReason('fail_fast') &&
          actionExecutions.restart_navigation === 1 &&
          restartTimeouts.length === 1 &&
          actionExecutions.force_reboot === 0 &&
          pendingApprovalCount === 0 &&
          oneTicket &&
          finalFailureState &&
          !taskSuccess;
    case 'approval_rejected':
      return manifest.config === 'full'
        ? hasSingleStopReason('approval_rejected') &&
          actionExecutions.restart_navigation === 2 &&
          restartTimeouts.length === 2 &&
          actionExecutions.force_reboot === 0 &&
          pendingApprovalCount === 1 &&
          rejectedDecisions.length === 1 &&
          nativeRejectedEvidence &&
          oneTicket &&
          finalFailureState &&
          !taskSuccess
        : manifest.config === 'fail-fast' &&
          hasSingleStopReason('fail_fast') &&
          actionExecutions.restart_navigation === 1 &&
          restartTimeouts.length === 1 &&
          actionExecutions.force_reboot === 0 &&
          pendingApprovalCount === 0 &&
          oneTicket &&
          finalFailureState &&
          !taskSuccess;
    case 'sop_missing':
      return (
        hasSingleStopReason('sop_not_found') &&
        actionExecutions.restart_navigation === 0 &&
        actionExecutions.force_reboot === 0 &&
        actionExecutions.resume_task === 0 &&
        sopNotFound &&
        oneTicket &&
        finalFailureState &&
        !taskSuccess
      );
    default:
      return false;
  }
}
