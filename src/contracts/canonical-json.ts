export function canonicalJson(value: unknown): string {
  return canonicalJsonValue(value, new WeakSet<object>());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function canonicalJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalize requires finite JSON numbers');
      }
      return JSON.stringify(value);
    case 'object': {
      if (ancestors.has(value)) {
        throw new TypeError('canonicalize does not accept circular references');
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${Array.from(
            { length: value.length },
            (_, index) => canonicalJsonValue(value[index], ancestors),
          ).join(',')}]`;
        }
        if (!isPlainObject(value)) {
          throw new TypeError('canonicalize accepts only plain JSON objects');
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
          throw new TypeError('canonicalize does not accept symbol keys');
        }

        const entries = Object.entries(value).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        );
        return `{${entries
          .map(
            ([key, child]) =>
              `${JSON.stringify(key)}:${canonicalJsonValue(child, ancestors)}`,
          )
          .join(',')}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new TypeError(`canonicalize does not accept ${typeof value}`);
  }
}
