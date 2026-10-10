import type { SafeError } from '../contracts/shared.js';

const SECRET_KEY = /(^|_)(api_?key|authorization|bearer|password|secret|token)($|_)/i;


function redactText(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join('[REDACTED]');
  }
  result = result
    .replace(/Authorization[ \t]*[:=][ \t]*(?:(?:Basic|Bearer)[ \t]+)?[^\s,}"']+/gi, 'Authorization: [REDACTED]')
    .replace(/Bearer[ \t]+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, '[REDACTED]');
  return result;
}

export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      Object.defineProperty(result, key, {
        value: SECRET_KEY.test(key) ? '[REDACTED]' : redactValue(child, secrets),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  return String(value);
}

export function safeError(error: unknown, secrets: readonly string[] = []): SafeError {
  if (error instanceof Error) {
    const coded = error as Error & { readonly code?: unknown };
    return {
      type: 'Error',
      name: error.name,
      code: typeof coded.code === 'string' ? coded.code : null,
      message: redactText(error.message || 'Error', secrets),
    };
  }
  return {
    type: typeof error,
    name: 'UnknownError',
    code: null,
    message: redactText(String(error), secrets),
  };
}
