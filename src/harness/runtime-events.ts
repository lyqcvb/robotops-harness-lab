import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session';

import type { ExecutionContext } from '../contracts/business.js';
import { canonicalJson } from '../contracts/canonical-json.js';
import type { SafeError } from './runtime-types.js';
import { isRecord } from './runtime-support.js';

/**
 * True only when the durable native log pairs an `approval/asked` for this exact
 * run/session/call with its own later `approval/decided` `allowed-once`.
 */
export function nativeApprovalGranted(
  nativeEvents: readonly unknown[],
  ctx: ExecutionContext,
): boolean {
  if (typeof ctx.session_id !== 'string' || ctx.session_id.length === 0) return false;
  if (typeof ctx.call_id !== 'string' || ctx.call_id.length === 0) return false;

  const askedIndexes: number[] = [];
  const askedSeqs: number[] = [];
  const askedIds: unknown[] = [];
  nativeEvents.forEach((event, index) => {
    if (
      isRecord(event)
      && event.type === 'approval/asked'
      && event.run_id === ctx.run_id
      && event.session_id === ctx.session_id
      && isRecord(event.data)
      && String(event.data.callId ?? '') === ctx.call_id
      && event.data.toolName === 'force_reboot'
    ) {
      askedIndexes.push(index);
      askedSeqs.push(typeof event.seq === 'number' ? event.seq : Number.NaN);
      askedIds.push(event.data.id);
    }
  });
  // Exactly one ask, one matching decision, and no ambiguity: fail closed otherwise.
  if (askedIndexes.length !== 1) return false;
  const askedIndex = askedIndexes[0] ?? -1;
  const askedSeq = askedSeqs[0] ?? Number.NaN;
  const askedId = askedIds[0];
  if (!Number.isFinite(askedSeq) || typeof askedId !== 'string' || askedId.length === 0) {
    return false;
  }

  const decidedIndexes: number[] = [];
  const decidedSeqs: number[] = [];
  let granted = false;
  nativeEvents.forEach((event, index) => {
    if (
      isRecord(event)
      && event.type === 'approval/decided'
      && event.run_id === ctx.run_id
      && event.session_id === ctx.session_id
      && isRecord(event.data)
      && event.data.id === askedId
    ) {
      decidedIndexes.push(index);
      decidedSeqs.push(typeof event.seq === 'number' ? event.seq : Number.NaN);
      if (event.data.outcome === 'allowed-once') granted = true;
    }
  });
  if (decidedIndexes.length !== 1 || !granted) return false;
  const decidedIndex = decidedIndexes[0] ?? -1;
  const decidedSeq = decidedSeqs[0] ?? Number.NaN;
  if (!Number.isFinite(decidedSeq) || decidedSeq <= askedSeq) return false;

  // Durable array order and sequence numbers must both advance past the ask.
  return decidedIndex > askedIndex;
}

function failureFromStream(stream: unknown): SafeError | null {
  if (!Array.isArray(stream)) return null;
  for (const record of stream) {
    if (!isRecord(record) || record.type !== 'chunk') continue;
    const chunk = record.chunk;
    if (!isRecord(chunk) || chunk.type !== 'finish') continue;
    const reason = chunk.reason;
    if (!isRecord(reason) || reason.kind !== 'error') continue;
    const failure = isRecord(reason.failure) ? reason.failure : {};
    return {
      name: 'LlmStreamError',
      message: typeof failure.message === 'string' ? failure.message : 'model stream failed',
      code: typeof failure.code === 'string' ? failure.code : 'UNKNOWN',
    };
  }
  return null;
}

export interface TerminalLlmState {
  readonly error: SafeError;
  readonly cancelled: boolean;
}

/**
 * Native durable truth for model/transport failure. A provider 401, rate limit,
 * or refused dispatch settles as a durable terminal turn/stream rather than a
 * thrown promise, so `whenIdle()` alone must never be treated as success.
 */
export function terminalLlmState(events: readonly unknown[]): TerminalLlmState | null {
  let state: TerminalLlmState | null = null;
  for (const event of events) {
    if (!isRecord(event) || !isRecord(event.data)) continue;
    if (event.type === 'assistant/attempt' || event.type === 'assistant/message') {
      const streamFailure = failureFromStream(event.data.stream);
      if (streamFailure !== null) state = { error: streamFailure, cancelled: false };
      continue;
    }
    if (event.type !== 'turn/end') continue;
    const reason = event.data.reason;
    if (!isRecord(reason)) continue;
    if (reason.kind === 'completed') continue;
    if (reason.kind === 'aborted') {
      state = {
        error: { name: 'RunCancelledError', message: 'agent turn was aborted', code: 'ABORTED' },
        cancelled: true,
      };
      continue;
    }
    if (reason.kind === 'error') {
      const failure = isRecord(reason.error) ? reason.error : {};
      state = {
        error: {
          name: 'LlmTurnError',
          message: typeof failure.message === 'string' ? failure.message : 'agent turn failed',
          code: typeof failure.code === 'string' ? failure.code : 'UNKNOWN',
        },
        cancelled: false,
      };
      continue;
    }
    const code = reason.kind === 'max-tokens' ? 'MAX_TOKENS'
      : reason.kind === 'blocked' ? 'TURN_BLOCKED'
        : 'TURN_INTERRUPTED';
    state = {
      error: {
        name: 'LlmTurnError',
        message: `agent turn ended without completion: ${String(reason.kind)}`,
        code,
      },
      cancelled: false,
    };
  }
  return state;
}

export async function readPersistedEvents(
  ctx: Context,
  sessionId: SessionId,
  expected: readonly SessionEvent[],
): Promise<number> {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read');
  let result: number | undefined;
  let primaryError: unknown;
  let closeError: unknown;
  try {
    const persisted = (await handle.read(0)).events;
    if (persisted.length !== expected.length) {
      throw new Error(
        `persisted session event count mismatch: actual=${persisted.length} expected=${expected.length}`,
      );
    }
    for (let index = 0; index < persisted.length; index += 1) {
      const actual = persisted[index];
      const wanted = expected[index];
      if (actual === undefined || wanted === undefined || Number(actual.seq) !== index || Number(wanted.seq) !== index) {
        throw new Error(`persisted session sequence is not contiguous at index ${index}`);
      }
      if (canonicalJson(actual) !== canonicalJson(wanted)) {
        throw new Error(`persisted session event mismatch at seq ${index}`);
      }
    }
    result = persisted.length;
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (closeError !== undefined) throw closeError;
  if (result === undefined) throw new Error('persisted session read produced no result');
  return result;
}
