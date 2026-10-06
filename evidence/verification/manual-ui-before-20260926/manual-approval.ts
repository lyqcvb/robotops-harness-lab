import process from 'node:process';
import { createInterface } from 'node:readline/promises';

import { canonicalize } from '../tools/tool-boundary.js';

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';

export interface ApprovalRequest {
  readonly run_id: string;
  readonly session_id: string;
  readonly call_id: string;
  readonly action: 'force_reboot';
  readonly args: Readonly<Record<string, string>>;
  readonly deadline_ms: number;
}

export type ApprovalDecide = (
  request: ApprovalRequest,
  signal?: AbortSignal,
) => Promise<ApprovalDecision>;

export interface ManualApprovalOptions {
  readonly reader?: NodeJS.ReadableStream;
  readonly writer?: NodeJS.WritableStream;
  readonly isTTY?: boolean;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 120_000;

function writeLine(writer: NodeJS.WritableStream, line: string): void {
  try {
    writer.write(`${line}\n`);
  } catch {
    // A closed test writer must not turn a fail-closed approval into a grant.
  }
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI;
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.trim() !== '0' &&
    value.trim().toLowerCase() !== 'false'
  );
}

function validateRequest(request: ApprovalRequest): string | null {
  if (typeof request.run_id !== 'string' || request.run_id.length === 0) {
    return 'run_id is missing';
  }
  if (typeof request.session_id !== 'string' || request.session_id.length === 0) {
    return 'session_id is missing';
  }
  if (typeof request.call_id !== 'string' || request.call_id.length === 0) {
    return 'call_id is missing';
  }
  if (request.action !== 'force_reboot') {
    return 'action is not force_reboot';
  }
  if (typeof request.args !== 'object' || request.args === null || Array.isArray(request.args)) {
    return 'canonical arguments are missing';
  }
  if (!Number.isFinite(request.deadline_ms)) {
    return 'deadline_ms is not finite';
  }
  return null;
}

function remainingTimeoutMs(
  request: ApprovalRequest,
  configuredTimeout: number | undefined,
  now: number,
): number | null {
  if (!Number.isFinite(request.deadline_ms)) return null;

  const requested = configuredTimeout ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(requested) || requested < 0) return null;

  return Math.min(
    Math.min(requested, MAX_TIMEOUT_MS),
    Math.max(0, request.deadline_ms - now),
  );
}

export function createManualApproval(options: ManualApprovalOptions = {}): ApprovalDecide {
  const reader = options.reader ?? process.stdin;
  const writer = options.writer ?? process.stdout;
  const injectedStreams = options.reader !== undefined || options.writer !== undefined;
  const defaultInteractive =
    !injectedStreams &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    !isCi(process.env);
  const interactive =
    options.isTTY === true ||
    (options.isTTY !== false && defaultInteractive) ||
    (options.isTTY !== false && injectedStreams);

  return async (request, signal) => {
    if (!interactive) {
      writeLine(
        writer,
        'Manual approval requires a real interactive TTY; approval cancelled. The action has not been executed.',
      );
      return 'cancelled';
    }

    const invalidReason = validateRequest(request);
    if (invalidReason !== null) {
      writeLine(writer, `Manual approval request is invalid (${invalidReason}); rejected.`);
      return 'rejected';
    }

    let canonicalArgs: string;
    try {
      canonicalArgs = canonicalize(request.args);
    } catch {
      writeLine(writer, 'Manual approval arguments cannot be canonicalized; rejected.');
      return 'rejected';
    }

    if (signal?.aborted === true) {
      writeLine(writer, 'Manual approval was cancelled by the caller; the action has not been executed.');
      return 'cancelled';
    }

    const now = options.now?.() ?? performance.now();
    if (!Number.isFinite(now)) {
      writeLine(writer, 'Manual approval clock is invalid; rejected.');
      return 'rejected';
    }
    const timeoutMs = remainingTimeoutMs(request, options.timeoutMs, now);
    if (timeoutMs === null) {
      writeLine(writer, 'Manual approval deadline is invalid; rejected.');
      return 'rejected';
    }

    writeLine(writer, `run_id: ${request.run_id}`);
    writeLine(writer, `session_id: ${request.session_id}`);
    writeLine(writer, `call_id: ${request.call_id}`);
    writeLine(writer, `action: ${request.action}`);
    writeLine(writer, `canonical args: ${canonicalArgs}`);
    writeLine(writer, `deadline_ms: ${request.deadline_ms}`);
    writeLine(writer, `approval timeout: ${timeoutMs}ms`);
    writeLine(writer, 'The action has not been executed. Type exactly "approve <call_id>" to approve or "reject <call_id>" to reject.');

    return await new Promise<ApprovalDecision>((resolve) => {
      const rl = createInterface({
        input: reader,
        output: writer,
        terminal: interactive,
      });
      let settled = false;
      const timeoutState: { timer?: ReturnType<typeof setTimeout> } = {};

      const finish = (decision: ApprovalDecision, message?: string): void => {
        if (settled) return;
        settled = true;
        if (timeoutState.timer !== undefined) clearTimeout(timeoutState.timer);
        signal?.removeEventListener('abort', onAbort);
        if (message !== undefined) writeLine(writer, message);
        try {
          rl.close();
        } catch {
          // Closing an already-ended test stream is safe for the fail-closed path.
        }
        resolve(decision);
      };

      const onAbort = (): void => {
        finish('cancelled', 'Manual approval was cancelled; the action has not been executed.');
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      rl.on('close', () => {
        if (!settled) {
          finish('rejected', 'Manual approval input ended before a decision; rejected.');
        }
      });

      if (timeoutMs === 0) {
        finish('rejected', 'Manual approval deadline expired; rejected.');
        return;
      }

      timeoutState.timer = setTimeout(() => {
        finish('rejected', 'Manual approval deadline expired; rejected.');
      }, timeoutMs);

      void (async () => {
        while (!settled) {
          let line: string;
          try {
            line = await rl.question('approval> ');
          } catch {
            finish('rejected', 'Manual approval input ended before a decision; rejected.');
            return;
          }
          if (settled) return;

          if (line === `approve ${request.call_id}`) {
            finish('approved', 'Manual approval granted once for this exact call.');
            return;
          }
          if (line === `reject ${request.call_id}`) {
            finish('rejected', 'Manual approval rejected.');
            return;
          }
          writeLine(
            writer,
            `Unrecognized input. Type exactly "approve ${request.call_id}" or "reject ${request.call_id}".`,
          );
        }
      })();
    });
  };
}




