import type {
  ExecutionContext,
  ResultStatus,
  ToolName,
  ToolResult,
} from '../contracts/business.js';
import { canonicalJson } from '../contracts/canonical-json.js';
import {
  RESULT_STATUSES,
  TOOL_PARAMETERS,
} from '../contracts/tool-protocol.js';

const RESULT_STATUS_SET: ReadonlySet<ResultStatus> = new Set(RESULT_STATUSES);

export function failure<T>(
  status: Exclude<ResultStatus, 'SUCCESS'>,
  errorCode: string,
  reason: string,
): ToolResult<T> {
  return { status, error_code: errorCode, reason, data: null };
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

export function sanitizeForTrace(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return `${value.toString()}n`;
    case 'undefined':
      return '[undefined]';
    case 'function':
      return '[function]';
    case 'symbol':
      return value.toString();
    case 'object': {
      if (ancestors.has(value)) return '[circular]';
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return value.map((item) => sanitizeForTrace(item, ancestors));
        }
        if (!isPlainObject(value)) {
          return `[object ${value.constructor?.name ?? 'unknown'}]`;
        }
        const result: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
          Object.defineProperty(result, key, {
            configurable: true,
            enumerable: true,
            value: sanitizeForTrace(child, ancestors),
            writable: true,
          });
        }
        return result;
      } finally {
        ancestors.delete(value);
      }
    }
  }
}

export function callIdOf(
  ctx: ExecutionContext | null | undefined,
): string | null {
  return typeof ctx?.call_id === 'string' && ctx.call_id.trim().length > 0
    ? ctx.call_id
    : null;
}

export function validateArguments(
  name: ToolName,
  args: unknown,
): ToolResult | null {
  if (!isPlainObject(args)) {
    return failure('DENIED', 'INVALID_ARGUMENTS', 'tool args must be a plain object');
  }
  if (Object.getOwnPropertySymbols(args).length > 0) {
    return failure('DENIED', 'INVALID_ARGUMENTS', 'tool args must not contain symbols');
  }
  if (Object.getOwnPropertyNames(args).length !== Object.keys(args).length) {
    return failure(
      'DENIED',
      'INVALID_ARGUMENTS',
      'tool args must contain only enumerable own fields',
    );
  }

  const expected = TOOL_PARAMETERS[name];
  const actual = Object.keys(args);
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(args, key))
  ) {
    return failure(
      'DENIED',
      'INVALID_ARGUMENTS',
      `tool ${name} requires exactly: ${expected.join(', ')}`,
    );
  }

  for (const key of expected) {
    const value = args[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return failure(
        'DENIED',
        'INVALID_ARGUMENTS',
        `argument ${key} must be a non-empty string`,
      );
    }
    if (key === 'reason' && value.length > 2_000) {
      return failure(
        'DENIED',
        'INVALID_ARGUMENTS',
        'argument reason must not exceed 2000 characters',
      );
    }
    if (key !== 'reason' && value.length > 200) {
      return failure(
        'DENIED',
        'INVALID_ARGUMENTS',
        `argument ${key} must not exceed 200 characters`,
      );
    }
  }
  return null;
}
export function validateOutput(value: unknown):
  | { readonly ok: true; readonly result: ToolResult }
  | { readonly ok: false } {
  try {
    if (!isPlainObject(value)) return { ok: false };
    if (Object.getOwnPropertySymbols(value).length > 0) return { ok: false };

    const ownKeys = Reflect.ownKeys(value);
    const expectedKeys = ['status', 'error_code', 'reason', 'data'];
    if (
      ownKeys.length !== expectedKeys.length ||
      ownKeys.some((key) => typeof key !== 'string') ||
      !expectedKeys.every((key) => Object.hasOwn(value, key))
    ) {
      return { ok: false };
    }

    const status = value.status;
    if (
      typeof status !== 'string' ||
      !RESULT_STATUS_SET.has(status as ResultStatus)
    ) {
      return { ok: false };
    }
    if (value.error_code !== null && typeof value.error_code !== 'string') {
      return { ok: false };
    }
    if (typeof value.reason !== 'string') return { ok: false };

    canonicalJson(value);
    return { ok: true, result: value as unknown as ToolResult };
  } catch {
    return { ok: false };
  }
}

export function classifyError(
  error: unknown,
): 'protocol' | 'runtime' | 'transport' {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (/protocol|parse|schema/i.test(`${name} ${message}`)) return 'protocol';
  if (
    /transport|network|fetch|socket|econn|etimed|eai_again|timeout/i.test(
      `${name} ${message}`,
    )
  ) {
    return 'transport';
  }
  return 'runtime';
}

export function errorDetails(error: unknown): {
  readonly name: string;
  readonly message: string;
} {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'UnknownError', message: String(error) };
}
