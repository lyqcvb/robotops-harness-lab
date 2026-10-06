import type { StreamChunk } from '@deepseek-ai/dsh-llm';

import type { ToolResult } from '../contracts/business.js';
import type { ToolName } from '../contracts/tool-protocol.js';
import type { SafeError } from './runtime-types.js';

export const OFFLINE_PROVIDER = 'business-scripted';
export const PERSISTENCE_SEGMENT = 'business';
export const MAX_TOKENS = 1024;
export const STREAM_IDLE_TIMEOUT_MS = 30_000;
export const MAX_TIMER_MS = 2_147_483_647;

export const TOOL_DESCRIPTIONS: Readonly<Record<ToolName, string>> = {
  get_robot_status: 'Read the current robot state, battery, fault code, and bound task.',
  get_task_status: 'Read the current task status and its bound robot.',
  search_sop: 'Look up the recovery SOP for an error code. Never invent recovery steps.',
  restart_navigation: 'Restart the navigation stack of a robot in ERROR state (recovery action, at most twice).',
  force_reboot: 'Submit a controlled reboot request for a robot in ERROR state. The host requires external one-time approval before any side effects. Without approval, the action will not execute.',
  resume_task: 'Resume a paused task after the robot has been verified healthy.',
  create_maintenance_ticket: 'Create an idempotent maintenance ticket for a robot that could not be recovered.',
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function safeError(error: unknown): SafeError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      code: typeof code === 'string' ? code : null,
    };
  }
  return { name: 'UnknownError', message: String(error), code: null };
}

export function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function asStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return null;
    result[key] = item;
  }
  return result;
}

export function denied(code: string, reason: string): ToolResult {
  return { status: 'DENIED', error_code: code, reason, data: null };
}

export function validateBaseUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const url = new URL(raw);
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('DEEPSEEK_BASE_URL must not contain userinfo, query, or fragment');
  }
  if (url.protocol === 'https:') return url.toString().replace(/\/$/, '');
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol === 'http:' && local) return url.toString().replace(/\/$/, '');
  throw new Error('DEEPSEEK_BASE_URL must use https, or http only for localhost test endpoints');
}

export function finishStream(chunk: StreamChunk): AsyncIterable<StreamChunk> {
  return (async function* stream(): AsyncIterable<StreamChunk> {
    yield chunk;
  })();
}

export function budgetFinish(message: string, code: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { message, code } } };
}

export function abortedFinish(message: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } } };
}
