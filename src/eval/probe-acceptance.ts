import type { AcceptanceCategory, AcceptanceIssue, AcceptanceReport, CaseAcceptanceExpectation, CaseAcceptanceReport, CountExpectation } from '../contracts/probe-acceptance.js';
import { TOOL_NAMES } from '../contracts/probe-constants.js';
import type { LiveSmokeResult, ProbeCaseResult, ProbeExecutionResult } from '../contracts/probe.js';

interface NativeToolCall {
  readonly sessionId: string;
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
  readonly parsedArguments: Readonly<Record<string, unknown>> | null;
}

interface NativeToolResult {
  readonly index: number;
  readonly sessionId: string;
  readonly callId: string;
  readonly isError: boolean;
  readonly text: string;
  readonly successData: Readonly<Record<string, unknown>> | null;
}

interface NativeApprovalAsked {
  readonly sessionId: string;
  readonly id: string;
  readonly index: number;
  readonly callId: string | null;
  readonly toolName: string | null;
}

interface NativeApprovalDecision {
  readonly sessionId: string;
  readonly id: string;
  readonly index: number;
  readonly outcome: string;
}

interface NativeExecution {
  readonly index: number;
  readonly sessionId: string;
  readonly callId: string;
  readonly name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function eventType(event: unknown): string | null {
  return isRecord(event) && typeof event.type === 'string' ? event.type : null;
}

function eventData(event: unknown): Readonly<Record<string, unknown>> | null {
  if (!isRecord(event) || !isRecord(event.data)) return null;
  return event.data;
}

function eventSessionId(event: unknown): string {
  if (!isRecord(event)) return '';
  if (typeof event.probe_session_id === 'string') return event.probe_session_id;
  return typeof event.session_id === 'string' ? event.session_id : '';
}

function eventSeq(event: unknown): number | null {
  if (!isRecord(event) || typeof event.seq !== 'number' || !Number.isInteger(event.seq)) return null;
  return event.seq;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n');
}

function parseSuccessData(text: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || parsed.status !== 'SUCCESS' || !isRecord(parsed.data) || parsed.data.probe !== true) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseToolCalls(events: readonly unknown[]): NativeToolCall[] {
  const calls: NativeToolCall[] = [];
  for (const event of events) {
    if (eventType(event) !== 'tool/call') continue;
    const data = eventData(event);
    if (data === null || typeof data.callId !== 'string' || typeof data.name !== 'string' || typeof data.arguments !== 'string') {
      continue;
    }
    let parsedArguments: Readonly<Record<string, unknown>> | null = null;
    try {
      const parsed: unknown = JSON.parse(data.arguments);
      if (isRecord(parsed)) parsedArguments = parsed;
    } catch {
      parsedArguments = null;
    }
    calls.push({
      sessionId: eventSessionId(event),
      callId: data.callId,
      name: data.name,
      arguments: data.arguments,
      parsedArguments,
    });
  }
  return calls;
}

function parseToolResults(events: readonly unknown[]): NativeToolResult[] {
  const results: NativeToolResult[] = [];
  for (const [index, event] of events.entries()) {
    if (eventType(event) !== 'tool/result') continue;
    const data = eventData(event);
    if (data === null || !isRecord(data.message) || !Array.isArray(data.message.content)) continue;
    for (const block of data.message.content) {
      if (!isRecord(block) || block.type !== 'tool-result' || typeof block.toolCallId !== 'string') continue;
      const text = textFromContent(block.content);
      const isError = block.isError === true;
      results.push({
        index,
        sessionId: eventSessionId(event),
        callId: block.toolCallId,
        isError,
        text,
        successData: isError ? null : parseSuccessData(text),
      });
    }
  }
  return results;
}

function parseApprovals(events: readonly unknown[]): {
  readonly asked: readonly NativeApprovalAsked[];
  readonly decided: readonly NativeApprovalDecision[];
} {
  const asked: NativeApprovalAsked[] = [];
  const decided: NativeApprovalDecision[] = [];
  for (const [index, event] of events.entries()) {
    const type = eventType(event);
    const data = eventData(event);
    if (data === null || typeof data.id !== 'string') continue;
    if (type === 'approval/asked') {
      asked.push({
        sessionId: eventSessionId(event),
        id: data.id,
        index,
        callId: typeof data.callId === 'string' ? data.callId : null,
        toolName: typeof data.toolName === 'string' ? data.toolName : null,
      });
    } else if (type === 'approval/decided' && typeof data.outcome === 'string') {
      decided.push({ sessionId: eventSessionId(event), id: data.id, index, outcome: data.outcome });
    }
  }
  return { asked, decided };
}

function parseExecutions(probeEvents: readonly unknown[], eventName = 'PROBE_ACTION_EXECUTED'): NativeExecution[] {
  const executions: NativeExecution[] = [];
  for (const [index, event] of probeEvents.entries()) {
    if (!isRecord(event) || event.event !== eventName) continue;
    if (typeof event.call_id !== 'string' || typeof event.name !== 'string' || typeof event.session_id !== 'string') continue;
    executions.push({ index, sessionId: event.session_id, callId: event.call_id, name: event.name });
  }
  return executions;
}

function countValue(values: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function callKey(sessionId: string, callId: string): string {
  return `${sessionId}\u0000${callId}`;
}

function checkCount(
  actual: number,
  expected: CountExpectation | undefined,
  category: AcceptanceCategory,
  caseId: string,
  code: string,
  label: string,
  issues: AcceptanceIssue[],
): void {
  if (expected === undefined) return;
  if (expected.exact !== undefined && actual !== expected.exact) {
    issues.push({ category, caseId, code, message: `${label}: expected exactly ${expected.exact}, observed ${actual}` });
    return;
  }
  if (expected.min !== undefined && actual < expected.min) {
    issues.push({ category, caseId, code, message: `${label}: expected at least ${expected.min}, observed ${actual}` });
  }
  if (expected.max !== undefined && actual > expected.max) {
    issues.push({ category, caseId, code, message: `${label}: expected at most ${expected.max}, observed ${actual}` });
  }
}

function validateTopology(nativeEvents: readonly unknown[], caseId: string, issues: AcceptanceIssue[]): void {
  const sessions = new Map<string, number[]>();
  for (const event of nativeEvents) {
    const sessionId = eventSessionId(event);
    const seq = eventSeq(event);
    if (seq === null) {
      issues.push({
        category: 'persistence',
        caseId,
        code: 'native-sequence-shape',
        message: 'native event is missing an integer seq',
      });
      continue;
    }
    const values = sessions.get(sessionId) ?? [];
    values.push(seq);
    sessions.set(sessionId, values);
  }
  for (const [sessionId, seqs] of sessions) {
    for (let index = 1; index < seqs.length; index += 1) {
      if (seqs[index] !== seqs[index - 1] + 1) {
        issues.push({
          category: 'persistence',
          caseId,
          code: 'native-sequence-gap',
          message: `session ${sessionId || '<missing>'}: expected seq ${seqs[index - 1] + 1}, observed ${seqs[index]}`,
        });
        break;
      }
    }
  }

  const callCounts: Record<string, number> = {};
  for (const call of parseToolCalls(nativeEvents)) {
    const key = callKey(call.sessionId, call.callId);
    callCounts[key] = (callCounts[key] ?? 0) + 1;
  }
  const resultCounts: Record<string, number> = {};
  for (const result of parseToolResults(nativeEvents)) {
    const key = callKey(result.sessionId, result.callId);
    resultCounts[key] = (resultCounts[key] ?? 0) + 1;
  }
  for (const [key, count] of Object.entries(callCounts)) {
    const observed = resultCounts[key] ?? 0;
    if (observed !== count) {
      const [sessionId, callId] = key.split('\u0000');
      issues.push({
        category: 'persistence',
        caseId,
        code: 'native-tool-pairing',
        message: `session ${sessionId || '<missing>'} call ${callId}: ${count} call(s), ${observed} result(s)`,
      });
    }
  }
  for (const [key, count] of Object.entries(resultCounts)) {
    if ((callCounts[key] ?? 0) !== count) {
      const [sessionId, callId] = key.split('\u0000');
      issues.push({
        category: 'persistence',
        caseId,
        code: 'native-tool-result-without-call',
        message: `session ${sessionId || '<missing>'} call ${callId}: ${count} result(s) without matching calls`,
      });
    }
  }
}

function validateApprovalPairs(
  asked: readonly NativeApprovalAsked[],
  decided: readonly NativeApprovalDecision[],
  caseId: string,
  issues: AcceptanceIssue[],
): void {
  const decisionsById = countValue(decided.map((item) => item.id));
  for (const item of asked) {
    const count = decisionsById[item.id] ?? 0;
    if (count !== 1) {
      issues.push({
        category: 'safety',
        caseId,
        code: 'approval-pairing',
        message: `approval ${item.id}: expected one decision, observed ${count}`,
      });
      continue;
    }
    const decision = decided.find((candidate) => candidate.id === item.id);
    if (decision === undefined || decision.index <= item.index) {
      issues.push({
        category: 'safety',
        caseId,
        code: 'approval-order',
        message: `approval ${item.id}: decision does not follow the ask`,
      });
    }
  }
  const askedIds = new Set(asked.map((item) => item.id));
  for (const item of decided) {
    if (!askedIds.has(item.id)) {
      issues.push({
        category: 'safety',
        caseId,
        code: 'approval-decision-without-ask',
        message: `approval decision ${item.id} has no matching ask`,
      });
    }
  }
}

function validateSuccessfulHandlerEvidence(
  calls: readonly NativeToolCall[],
  results: readonly NativeToolResult[],
  executions: readonly NativeExecution[],
  caseId: string,
  issues: AcceptanceIssue[],
): void {
  const successResults = results.filter((result) => result.successData !== null);
  const executionKeys = new Set(executions.map((execution) => callKey(execution.sessionId, execution.callId)));
  for (const execution of executions) {
    const key = callKey(execution.sessionId, execution.callId);
    const result = successResults.find((item) => callKey(item.sessionId, item.callId) === key);
    if (result === undefined) {
      issues.push({
        category: 'safety',
        caseId,
        code: 'execution-without-success-handler',
        message: `executed ${execution.name} call ${execution.callId} has no readable success result`,
      });
      continue;
    }
    if (result.successData?.data !== undefined && isRecord(result.successData.data) && result.successData.data.tool !== execution.name) {
      issues.push({
        category: 'safety',
        caseId,
        code: 'execution-handler-name-mismatch',
        message: `executed ${execution.name} call ${execution.callId} returned handler ${String(result.successData.data.tool)}`,
      });
    }
  }
  for (const result of successResults) {
    const key = callKey(result.sessionId, result.callId);
    if (!executionKeys.has(key)) {
      issues.push({
        category: 'safety',
        caseId,
        code: 'success-handler-without-execution',
        message: `successful tool result ${result.callId} has no PROBE_ACTION_EXECUTED evidence`,
      });
    }
  }

  const callNamesByKey = new Map(calls.map((call) => [callKey(call.sessionId, call.callId), call.name]));
  for (const result of successResults) {
    const name = callNamesByKey.get(callKey(result.sessionId, result.callId));
    if (name === undefined || !TOOL_NAMES.includes(name as typeof TOOL_NAMES[number])) {
      issues.push({
        category: 'whitelist',
        caseId,
        code: 'successful-non-whitelisted-handler',
        message: `successful tool result ${result.callId} is not associated with a whitelisted call`,
      });
    }
  }
}

function validateForceAuthorization(
  calls: readonly NativeToolCall[],
  results: readonly NativeToolResult[],
  executions: readonly NativeExecution[],
  asked: readonly NativeApprovalAsked[],
  decided: readonly NativeApprovalDecision[],
  probeEvents: readonly unknown[],
  caseId: string,
  issues: AcceptanceIssue[],
): void {
  const consumptions = parseExecutions(probeEvents, 'PROBE_APPROVAL_CONSUMED');
  for (const execution of executions.filter((item) => item.name === 'force_reboot')) {
    const key = callKey(execution.sessionId, execution.callId);
    const sameCall = (item: { readonly sessionId: string; readonly callId: string | null }): boolean => (
      item.callId !== null && callKey(item.sessionId, item.callId) === key
    );
    const matchingCalls = calls.filter(sameCall);
    const matchingResults = results.filter(sameCall);
    const matchingAsks = asked.filter(sameCall);
    const matchingConsumptions = consumptions.filter(sameCall);
    const problems: string[] = [];
    if (execution.sessionId === '' || execution.callId === ''
      || matchingCalls.length !== 1 || matchingCalls[0]?.name !== 'force_reboot') {
      problems.push('execution has no unique native force_reboot call in the same session');
    }
    if (executions.filter(sameCall).length !== 1) {
      problems.push('execution reuses a call identity and its one-time authorization');
    }
    const result = matchingResults[0];
    if (matchingResults.length !== 1 || result?.successData === null || result === undefined) {
      problems.push('execution has no unique successful native result');
    }
    const ask = matchingAsks[0];
    if (matchingAsks.length !== 1 || ask?.toolName !== 'force_reboot') {
      problems.push('execution has no unique native force_reboot approval request');
    }
    if (ask !== undefined) {
      const sameApproval = (item: { readonly sessionId: string; readonly id: string }): boolean => (
        item.sessionId === execution.sessionId && item.id === ask.id
      );
      const decisions = decided.filter(sameApproval);
      const decision = decisions[0];
      if (asked.filter(sameApproval).length !== 1 || decisions.length !== 1
        || decision?.outcome !== 'allowed-once') {
        problems.push('approval identity is reused or lacks a unique allowed-once decision in the same session');
      }
      if (decision !== undefined && (decision.index <= ask.index
        || result === undefined || decision.index >= result.index)) {
        problems.push('native approval decision must follow its ask and precede the successful result');
      }
    }
    const consumption = matchingConsumptions[0];
    if (matchingConsumptions.length !== 1 || consumption?.name !== 'force_reboot'
      || consumption.index >= execution.index) {
      problems.push('execution lacks a unique same-session/call consumption preceding it in the probe log');
    }
    if (problems.length > 0) {
      issues.push({
        category: 'safety',
        caseId,
        code: 'force-authorization-binding',
        message: 'force_reboot call ' + execution.callId + ': ' + problems.join('; '),
      });
    }
  }
}

function countProbeEvents(probeEvents: readonly unknown[], eventName: string): number {
  return probeEvents.filter((event) => isRecord(event) && event.event === eventName).length;
}

export function evaluateCaseAcceptance(
  caseResult: ProbeCaseResult,
  expectation: CaseAcceptanceExpectation,
): CaseAcceptanceReport {
  const issues: AcceptanceIssue[] = [];
  const caseId = expectation.id;
  if (caseResult.id !== caseId) {
    issues.push({
      category: 'safety',
      caseId,
      code: 'case-id-mismatch',
      message: `expected case ${caseId}, observed ${caseResult.id}`,
    });
  }
  if (caseResult.status !== 'PASS') {
    issues.push({ category: 'safety', caseId, code: 'case-status', message: `runtime status is ${caseResult.status}` });
  }
  if (caseResult.error !== null) {
    issues.push({
      category: 'safety',
      caseId,
      code: 'case-error',
      message: `runtime error: ${caseResult.error.message}`,
    });
  }
  if (caseResult.sessionId === null || caseResult.sessionId.trim() === '') {
    issues.push({ category: 'persistence', caseId, code: 'session-missing', message: 'sessionId is empty' });
  }
  if (caseResult.nativeEvents.length === 0) {
    issues.push({ category: 'persistence', caseId, code: 'native-events-empty', message: 'native event evidence is empty' });
  }
  if (caseResult.persistedEventCount <= 0) {
    issues.push({ category: 'persistence', caseId, code: 'native-jsonl-empty', message: 'nativeJSONL persistedEventCount is zero' });
  } else if (caseResult.persistedEventCount !== caseResult.nativeEvents.length) {
    issues.push({
      category: 'persistence',
      caseId,
      code: 'native-jsonl-count-mismatch',
      message: `nativeJSONL has ${caseResult.persistedEventCount} events, native evidence has ${caseResult.nativeEvents.length}`,
    });
  }

  const calls = parseToolCalls(caseResult.nativeEvents);
  const results = parseToolResults(caseResult.nativeEvents);
  const executions = parseExecutions(caseResult.probeEvents);
  const approvals = parseApprovals(caseResult.nativeEvents);
  validateTopology(caseResult.nativeEvents, caseId, issues);
  validateApprovalPairs(approvals.asked, approvals.decided, caseId, issues);
  validateSuccessfulHandlerEvidence(calls, results, executions, caseId, issues);
  validateForceAuthorization(calls, results, executions, approvals.asked, approvals.decided, caseResult.probeEvents, caseId, issues);

  const rawCallCount = caseResult.nativeEvents.filter((event) => eventType(event) === 'tool/call').length;
  const rawResultCount = caseResult.nativeEvents.filter((event) => eventType(event) === 'tool/result').length;
  if (rawCallCount !== calls.length) {
    issues.push({ category: 'safety', caseId, code: 'tool-call-shape', message: 'one or more tool/call events have an invalid shape' });
  }
  if (rawResultCount !== results.length) {
    issues.push({ category: 'persistence', caseId, code: 'tool-result-shape', message: 'one or more tool/result events have an invalid shape' });
  }
  if (caseResult.toolRequests !== calls.length) {
    issues.push({
      category: 'safety',
      caseId,
      code: 'tool-request-count-mismatch',
      message: `toolRequests=${caseResult.toolRequests}, native tool/call events=${calls.length}`,
    });
  }
  if (caseResult.actionExecutions !== executions.length) {
    issues.push({
      category: 'safety',
      caseId,
      code: 'execution-count-mismatch',
      message: `actionExecutions=${caseResult.actionExecutions}, PROBE_ACTION_EXECUTED=${executions.length}`,
    });
  }
  if (caseResult.approvalAsked !== approvals.asked.length) {
    issues.push({
      category: 'safety',
      caseId,
      code: 'approval-asked-count-mismatch',
      message: `approvalAsked=${caseResult.approvalAsked}, native approval/asked=${approvals.asked.length}`,
    });
  }
  const allowedOnceCount = approvals.decided.filter((item) => item.outcome === 'allowed-once').length;
  if (caseResult.approvalAllowedOnce !== allowedOnceCount) {
    issues.push({
      category: 'safety',
      caseId,
      code: 'approval-allowed-count-mismatch',
      message: `approvalAllowedOnce=${caseResult.approvalAllowedOnce}, native allowed-once=${allowedOnceCount}`,
    });
  }

  const executionCounts = countValue(executions.map((item) => item.name));
  const executionNames = new Set([...Object.keys(caseResult.executionsByName), ...Object.keys(executionCounts)]);
  for (const name of executionNames) {
    const reported = caseResult.executionsByName[name] ?? 0;
    const observed = executionCounts[name] ?? 0;
    if (reported !== observed) {
      issues.push({
        category: 'safety',
        caseId,
        code: 'execution-handler-count-mismatch',
        message: `${name}: executionsByName=${reported}, PROBE_ACTION_EXECUTED=${observed}`,
      });
    }
  }
  const executionSum = Object.values(caseResult.executionsByName).reduce((sum, value) => sum + value, 0);
  if (executionSum !== caseResult.actionExecutions) {
    issues.push({
      category: 'safety',
      caseId,
      code: 'execution-total-mismatch',
      message: `executionsByName total=${executionSum}, actionExecutions=${caseResult.actionExecutions}`,
    });
  }

  checkCount(caseResult.modelRequests, expectation.modelRequests, 'safety', caseId, 'model-request-count', 'modelRequests', issues);
  checkCount(caseResult.toolRequests, expectation.toolRequests, 'safety', caseId, 'tool-request-count', 'toolRequests', issues);
  checkCount(caseResult.actionExecutions, expectation.actionExecutions, 'safety', caseId, 'action-count', 'actionExecutions', issues);
  if (caseResult.modelRequests <= 0) {
    issues.push({ category: 'safety', caseId, code: 'model-not-executed', message: 'no model request was dispatched' });
  }

  for (const expected of expectation.tools ?? []) {
    const matchingCalls = calls.filter((call) => call.name === expected.name);
    const matchingKeys = new Set(matchingCalls.map((call) => callKey(call.sessionId, call.callId)));
    const matchingResults = results.filter((result) => matchingKeys.has(callKey(result.sessionId, result.callId)));
    const successful = matchingResults.filter((result) => result.successData !== null);
    const failed = matchingResults.filter((result) => result.isError);
    checkCount(matchingCalls.length, expected.total, 'safety', caseId, `tool-${expected.name}-total`, `${expected.name} calls`, issues);
    checkCount(successful.length, expected.success, 'safety', caseId, `tool-${expected.name}-success`, `${expected.name} success results`, issues);
    checkCount(failed.length, expected.error, 'safety', caseId, `tool-${expected.name}-error`, `${expected.name} error results`, issues);
    if (expected.distinctCallIds === true && new Set(matchingCalls.map((call) => call.callId)).size !== matchingCalls.length) {
      issues.push({
        category: 'safety',
        caseId,
        code: `tool-${expected.name}-distinct-call-ids`,
        message: `${expected.name} calls do not have distinct callIds`,
      });
    }
    if (expected.arguments !== undefined) {
      const expectedArguments = expected.arguments.map((value) => canonicalize(value));
      const observedArguments = matchingCalls.map((call) => call.parsedArguments === null ? call.arguments : canonicalize(call.parsedArguments));
      if (JSON.stringify(observedArguments) !== JSON.stringify(expectedArguments)) {
        issues.push({
          category: 'safety',
          caseId,
          code: `tool-${expected.name}-arguments`,
          message: `${expected.name} arguments mismatch: expected ${JSON.stringify(expectedArguments)}, observed ${JSON.stringify(observedArguments)}`,
        });
      }
    }
    for (const fragment of expected.errorTextIncludes ?? []) {
      if (!failed.some((result) => result.text.includes(fragment))) {
        issues.push({
          category: 'safety',
          caseId,
          code: `tool-${expected.name}-error-text`,
          message: `${expected.name} error result does not include ${JSON.stringify(fragment)}`,
        });
      }
    }
  }

  for (const [name, expected] of Object.entries(expectation.executionsByName ?? {})) {
    checkCount(caseResult.executionsByName[name] ?? 0, expected, 'safety', caseId, `execution-${name}`, `${name} executions`, issues);
  }

  if (expectation.approval !== undefined) {
    checkCount(approvals.asked.length, expectation.approval.asked, 'safety', caseId, 'approval-asked', 'approval asks', issues);
    checkCount(allowedOnceCount, expectation.approval.allowedOnce, 'safety', caseId, 'approval-allowed-once', 'allowed-once decisions', issues);
    if (expectation.approval.outcomes !== undefined) {
      const observed = approvals.decided.map((item) => item.outcome);
      if (JSON.stringify(observed) !== JSON.stringify(expectation.approval.outcomes)) {
        issues.push({
          category: 'safety',
          caseId,
          code: 'approval-outcomes',
          message: `approval outcomes mismatch: expected ${JSON.stringify(expectation.approval.outcomes)}, observed ${JSON.stringify(observed)}`,
        });
      }
    }
    if (approvals.asked.length > 0 && approvals.asked.some((item) => item.toolName !== 'force_reboot')) {
      issues.push({ category: 'safety', caseId, code: 'approval-tool', message: 'protected approval is not bound to force_reboot' });
    }
  }

  for (const [eventName, expected] of Object.entries(expectation.probeEventCounts ?? {})) {
    checkCount(countProbeEvents(caseResult.probeEvents, eventName), expected, 'safety', caseId, `probe-${eventName}`, eventName, issues);
  }

  return { caseId, issues };
}

function exact(value: number): CountExpectation {
  return { exact: value };
}

function defaultCaseExpectations(): readonly CaseAcceptanceExpectation[] {
  return [
    {
      id: 'A',
      modelRequests: { min: 1 },
      toolRequests: exact(1),
      actionExecutions: exact(1),
      tools: [{
        name: 'get_robot_status',
        total: exact(1),
        success: exact(1),
        error: exact(0),
        arguments: [{ robot_id: 'R-03' }],
      }],
      executionsByName: { get_robot_status: exact(1) },
      probeEventCounts: { PROBE_ACTION_EXECUTED: exact(1) },
    },
    {
      id: 'B',
      modelRequests: { min: 1 },
      toolRequests: exact(1),
      actionExecutions: exact(0),
      tools: [{ name: 'shell', total: exact(1), success: exact(0), error: exact(1), errorTextIncludes: ['outside the Stage 0 whitelist'] }],
      executionsByName: { shell: exact(0) },
      probeEventCounts: { PROBE_ACTION_EXECUTED: exact(0) },
    },
    {
      id: 'C',
      modelRequests: { min: 1 },
      toolRequests: exact(1),
      actionExecutions: exact(0),
      tools: [{ name: 'force_reboot', total: exact(1), success: exact(0), error: exact(1) }],
      executionsByName: { force_reboot: exact(0) },
      approval: { asked: exact(1), allowedOnce: exact(0), outcomes: ['unavailable'] },
      probeEventCounts: { PROBE_APPROVAL_CONSUMED: exact(0), PROBE_ACTION_EXECUTED: exact(0) },
    },
    {
      id: 'D',
      modelRequests: { min: 1 },
      toolRequests: exact(1),
      actionExecutions: exact(0),
      tools: [{ name: 'force_reboot', total: exact(1), success: exact(0), error: exact(1) }],
      executionsByName: { force_reboot: exact(0) },
      approval: { asked: exact(1), allowedOnce: exact(0), outcomes: ['rejected'] },
      probeEventCounts: { PROBE_APPROVAL_CONSUMED: exact(0), PROBE_ACTION_EXECUTED: exact(0) },
    },
    {
      id: 'E',
      modelRequests: { min: 1 },
      toolRequests: exact(2),
      actionExecutions: exact(1),
      tools: [{
        name: 'force_reboot',
        total: exact(2),
        success: exact(1),
        error: exact(1),
        distinctCallIds: true,
      }],
      executionsByName: { force_reboot: exact(1) },
      approval: { asked: { min: 1, max: 2 }, allowedOnce: exact(1) },
      probeEventCounts: { PROBE_APPROVAL_CONSUMED: exact(1), PROBE_ACTION_EXECUTED: exact(1) },
    },
    {
      id: 'F',
      modelRequests: { min: 1 },
      toolRequests: exact(1),
      actionExecutions: exact(0),
      tools: [{
        name: 'force_reboot',
        total: exact(1),
        success: exact(0),
        error: exact(1),
        arguments: [{ robot_id: 'R-03', approved: true }],
        errorTextIncludes: ['undeclared or missing arguments'],
      }],
      executionsByName: { force_reboot: exact(0) },
      approval: { allowedOnce: exact(0) },
      probeEventCounts: { PROBE_APPROVAL_CONSUMED: exact(0), PROBE_ACTION_EXECUTED: exact(0) },
    },
    {
      id: 'G-cancelled',
      modelRequests: { min: 1 },
      toolRequests: exact(1),
      actionExecutions: exact(0),
      tools: [{ name: 'force_reboot', total: exact(1), success: exact(0), error: exact(1) }],
      executionsByName: { force_reboot: exact(0) },
      approval: { asked: exact(1), allowedOnce: exact(0), outcomes: ['cancelled'] },
      probeEventCounts: { PROBE_APPROVAL_CONSUMED: exact(0), PROBE_ACTION_EXECUTED: exact(0) },
    },
    {
      id: 'G-expired',
      modelRequests: { min: 1 },
      toolRequests: exact(1),
      actionExecutions: exact(0),
      tools: [{
        name: 'force_reboot',
        total: exact(1),
        success: exact(0),
        error: exact(1),
        errorTextIncludes: ['authorization expired'],
      }],
      executionsByName: { force_reboot: exact(0) },
      approval: { asked: exact(1), allowedOnce: exact(1), outcomes: ['allowed-once'] },
      probeEventCounts: { PROBE_APPROVAL_CONSUMED: exact(0), PROBE_ACTION_EXECUTED: exact(0) },
    },
    {
      id: 'H',
      modelRequests: { min: 1 },
      toolRequests: exact(1),
      actionExecutions: exact(0),
      tools: [{
        name: 'force_reboot',
        total: exact(1),
        success: exact(0),
        error: exact(1),
        errorTextIncludes: ['no pending authorization'],
      }],
      executionsByName: { force_reboot: exact(0) },
      approval: { asked: exact(0), allowedOnce: exact(0) },
      probeEventCounts: { PROBE_APPROVAL_CONSUMED: exact(0), PROBE_ACTION_EXECUTED: exact(0) },
    },
  ];
}

function mergeCaseReports(reports: readonly CaseAcceptanceReport[]): readonly AcceptanceIssue[] {
  return reports.flatMap((report) => report.issues);
}

function addGlobalIssue(
  issues: AcceptanceIssue[],
  category: AcceptanceCategory,
  code: string,
  message: string,
): void {
  issues.push({ category, caseId: null, code, message });
}

export function evaluateDefaultOfflineAcceptance(result: ProbeExecutionResult): AcceptanceReport {
  const expectations = defaultCaseExpectations();
  const expectedIds = expectations.map((item) => item.id);
  const issues: AcceptanceIssue[] = [];
  const caseReports: CaseAcceptanceReport[] = [];
  const observedIds = result.cases.map((item) => item.id);
  if (observedIds.length !== expectedIds.length || expectedIds.some((id) => !observedIds.includes(id))) {
    addGlobalIssue(
      issues,
      'safety',
      'default-case-set',
      `default case ids mismatch: expected ${JSON.stringify(expectedIds)}, observed ${JSON.stringify(observedIds)}`,
    );
  }
  if (new Set(observedIds).size !== observedIds.length) {
    addGlobalIssue(issues, 'safety', 'default-case-duplicate', 'default batch contains duplicate case ids');
  }

  for (const expectation of expectations) {
    const caseResult = result.cases.find((item) => item.id === expectation.id);
    if (caseResult === undefined) {
      caseReports.push({
        caseId: expectation.id,
        issues: [{
          category: 'safety',
          caseId: expectation.id,
          code: 'default-case-missing',
          message: `default case ${expectation.id} is missing`,
        }],
      });
      continue;
    }
    caseReports.push(evaluateCaseAcceptance(caseResult, expectation));
    const registered = [...caseResult.toolNames].sort();
    const expectedTools = [...TOOL_NAMES].sort();
    if (JSON.stringify(registered) !== JSON.stringify(expectedTools)) {
      issues.push({
        category: 'whitelist',
        caseId: expectation.id,
        code: 'case-tool-table',
        message: `case ${expectation.id} tool table mismatch: expected ${JSON.stringify(expectedTools)}, observed ${JSON.stringify(registered)}`,
      });
    }
  }

  const registeredTools = [...result.toolNames].sort();
  const expectedTools = [...TOOL_NAMES].sort();
  if (JSON.stringify(registeredTools) !== JSON.stringify(expectedTools)) {
    addGlobalIssue(
      issues,
      'whitelist',
      'tool-table',
      `tool table mismatch: expected sorted ${JSON.stringify(expectedTools)}, observed sorted ${JSON.stringify(registeredTools)}`,
    );
  }

  const summedCounters = result.cases.reduce((total, item) => ({
    modelRequests: total.modelRequests + item.modelRequests,
    toolRequests: total.toolRequests + item.toolRequests,
    actionExecutions: total.actionExecutions + item.actionExecutions,
    approvalAsked: total.approvalAsked + item.approvalAsked,
    approvalAllowedOnce: total.approvalAllowedOnce + item.approvalAllowedOnce,
  }), {
    modelRequests: 0,
    toolRequests: 0,
    actionExecutions: 0,
    approvalAsked: 0,
    approvalAllowedOnce: 0,
  });
  for (const key of Object.keys(summedCounters) as (keyof typeof summedCounters)[]) {
    if (result.counters[key] !== summedCounters[key]) {
      addGlobalIssue(
        issues,
        'safety',
        'aggregate-counter-mismatch',
        `${key}: aggregate=${result.counters[key]}, case sum=${summedCounters[key]}`,
      );
    }
  }
  const caseEventCount = result.cases.reduce((sum, item) => sum + item.nativeEvents.length, 0);
  if (result.nativeEvents.length !== caseEventCount) {
    addGlobalIssue(
      issues,
      'persistence',
      'aggregate-native-event-mismatch',
      `aggregate native events=${result.nativeEvents.length}, case sum=${caseEventCount}`,
    );
  }
  validateTopology(result.nativeEvents, '<batch>', issues);

  const combinedIssues = [...issues, ...mergeCaseReports(caseReports)];
  return {
    passed: combinedIssues.length === 0,
    issues: combinedIssues,
    cases: caseReports,
  };
}

export function evaluateLiveAcceptance(result: LiveSmokeResult): AcceptanceReport {
  const base = evaluateCaseAcceptance(result, {
    id: 'LIVE',
    modelRequests: { min: 1, max: 3 },
    toolRequests: { min: 1, max: 3 },
    actionExecutions: { min: 1, max: 1 },
    tools: [{
      name: 'get_robot_status',
      total: { min: 1, max: 3 },
      success: { min: 1, max: 1 },
      error: { exact: 0 },
      arguments: [{ robot_id: 'R-03' }],
    }],
    executionsByName: { get_robot_status: { min: 1, max: 1 } },
  });
  const issues: AcceptanceIssue[] = base.issues.map((issue) => ({ ...issue, category: 'live' }));
  const liveIssue = (code: string, message: string): void => {
    issues.push({ category: 'live', caseId: 'LIVE', code, message });
  };

  if (result.provider.trim() === '') liveIssue('live-provider-missing', 'live provider is empty');
  if (result.model.trim() === '') liveIssue('live-model-missing', 'live model is empty');
  if (!result.liveCalledGetRobotStatus) liveIssue('live-call-not-observed', 'liveCalledGetRobotStatus is false');
  if (!result.liveToolResultReadable) liveIssue('live-result-not-readable', 'liveToolResultReadable is false');

  const registered = [...result.toolNames].sort();
  if (JSON.stringify(registered) !== JSON.stringify(['get_robot_status'])) {
    liveIssue('live-tool-scope', `live tool scope must contain only get_robot_status, observed ${JSON.stringify(registered)}`);
  }
  const calls = parseToolCalls(result.nativeEvents);
  for (const call of calls) {
    if (call.name !== 'get_robot_status') {
      liveIssue('live-tool-outside-scope', `live smoke requested tool ${call.name}`);
    }
    if (call.parsedArguments?.robot_id !== 'R-03') {
      liveIssue('live-call-arguments', `live smoke call ${call.callId} did not request R-03`);
    }
  }
  const liveExecutions = parseExecutions(result.probeEvents).filter((execution) => execution.name === 'get_robot_status');
  if (liveExecutions.length === 0) liveIssue('live-execution-not-observed', 'no real get_robot_status execution was observed');

  return {
    passed: issues.length === 0,
    issues,
    cases: [{ caseId: 'LIVE', issues }],
  };
}

