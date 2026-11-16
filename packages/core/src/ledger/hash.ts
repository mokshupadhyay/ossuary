import { createHash } from 'node:crypto';

/**
 * Canonical serialization rules:
 * - Object keys are sorted (code-unit order) at every depth.
 * - Arrays keep their order.
 * - bigint -> unquoted `<digits>n` token (e.g. `100n`). Strings are always quoted and
 *   numbers never carry an `n`, so no other value serializes to this form.
 * - Properties whose value is `undefined` are omitted, so `{a: undefined}` equals `{}`.
 *   `undefined` inside an array, or at top level, is rejected.
 * - Functions, symbols, non-finite numbers, and non-plain objects
 *   (Date, Map, class instances, ...) throw TypeError.
 */
function canonicalize(value: unknown): string {
  switch (typeof value) {
    case 'bigint':
      return `${value.toString()}n`;
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot hash non-finite number: ${value}`);
      }
      return JSON.stringify(value);
    case 'object': {
      if (value === null) return 'null';
      if (Array.isArray(value)) {
        return `[${value.map((v) => {
          if (v === undefined) throw new TypeError('Cannot hash undefined array element');
          return canonicalize(v);
        }).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('Cannot hash non-plain object');
      }
      const obj = value as Record<string, unknown>;
      const parts = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`Cannot hash value of type ${typeof value}`);
  }
}

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}
