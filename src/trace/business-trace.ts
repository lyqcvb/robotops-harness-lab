import type { BusinessEvent } from '../contracts/business.js';

export interface BusinessTraceOptions {
  readonly runId: string;
  readonly scenarioId?: string;
  readonly sessionId?: string | null;
  readonly now?: () => number;
}

function cloneJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} must contain only finite JSON numbers`);
      }
      return value;
    case 'object': {
      if (ancestors.has(value)) {
        throw new TypeError(`${path} must not contain circular references`);
      }

      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return value.map((item, index) =>
            cloneJsonValue(item, `${path}[${index}]`, ancestors),
          );
        }

        const prototype: object | null = Object.getPrototypeOf(value) as object | null;
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError(`${path} must contain only plain JSON objects`);
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
          throw new TypeError(`${path} must not contain symbol-keyed properties`);
        }

        const result: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          Object.defineProperty(result, key, {
            configurable: true,
            enumerable: true,
            value: cloneJsonValue(child, `${path}.${key}`, ancestors),
            writable: true,
          });
        }
        return result;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new TypeError(`${path} must be JSON-compatible`);
  }
}

function cloneJsonObject(
  value: Record<string, unknown>,
  path = 'data',
): Record<string, unknown> {
  const cloned = cloneJsonValue(value, path, new WeakSet<object>());
  if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new TypeError(`${path} must be a JSON object`);
  }
  return cloned as Record<string, unknown>;
}

function cloneEvent(event: BusinessEvent): BusinessEvent {
  return {
    ...event,
    data: cloneJsonObject(event.data),
  };
}

export class BusinessTrace {
  readonly #runId: string;
  readonly #scenarioId: string;
  readonly #now: () => number;
  #sessionId: string | null;
  #events: BusinessEvent[] = [];

  constructor(options: BusinessTraceOptions) {
    this.#runId = options.runId;
    this.#scenarioId = options.scenarioId ?? 'unit';
    this.#sessionId = options.sessionId ?? null;
    this.#now = options.now ?? (() => performance.now());
  }

  get runId(): string {
    return this.#runId;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get scenarioId(): string {
    return this.#scenarioId;
  }

  record(
    type: string,
    callId: string | null,
    data: Record<string, unknown>,
  ): BusinessEvent {
    const clonedData = cloneJsonObject(data);
    const atMs = this.#now();
    if (!Number.isFinite(atMs)) {
      throw new TypeError('now() must return a finite number');
    }

    const event: BusinessEvent = {
      run_id: this.#runId,
      session_id: this.#sessionId,
      scenario_id: this.#scenarioId,
      seq: this.#events.length + 1,
      at_ms: atMs,
      call_id: callId,
      type,
      data: clonedData,
    };
    this.#events.push(event);
    return cloneEvent(event);
  }

  events(): BusinessEvent[] {
    return this.#events.map((event) => cloneEvent(event));
  }

  setSessionId(sessionId: string): void {
    if (sessionId.trim().length === 0) {
      throw new TypeError('sessionId must be a real non-empty identifier');
    }
    if (this.#sessionId !== null && this.#sessionId !== sessionId) {
      throw new Error(
        `Cannot change sessionId from ${this.#sessionId} to ${sessionId}`,
      );
    }
    if (this.#sessionId === sessionId) return;

    this.#sessionId = sessionId;
    this.#events = this.#events.map((event) => ({
      ...event,
      session_id: sessionId,
    }));
  }
}
