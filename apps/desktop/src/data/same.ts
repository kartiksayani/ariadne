import { CoreFailure, ServiceFailure } from './service';

/**
 * Structural equality for plain data (primitives, arrays, plain objects). The stores use it to keep the previous object
 * when a poll read the same data, so an unchanged poll hands React the very same references and nothing redraws.
 * For JSON data only: a Map, a Set or a Date has no own enumerable keys, so any two of them compare equal.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as readonly unknown[];
    return a.length === other.length && a.every((value, index) => sameValue(value, other[index]));
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]));
}

/** The same failure read again: the same service reason, or the same core error. A repeat of a failure already shown is no news. */
export function sameFailure(a: CoreFailure | ServiceFailure | null, b: CoreFailure | ServiceFailure | null): boolean {
  if (a === b) return true;
  if (a instanceof CoreFailure && b instanceof CoreFailure) return sameValue(a.error, b.error);
  if (a instanceof ServiceFailure && b instanceof ServiceFailure) return a.reason === b.reason;
  return false;
}

/** True when every key of `update` already holds that very value in `state`: publishing it would change nothing. */
export function changesNothing<T extends object>(state: T, update: Partial<T>): boolean {
  const current = state as Record<string, unknown>;
  return Object.entries(update).every(([key, value]) => Object.is(current[key], value));
}
