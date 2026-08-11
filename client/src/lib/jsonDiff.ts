/**
 * Minimal JSON diff utility — no external deps.
 * Compares two plain objects and returns a list of field-level changes.
 */

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface DiffEntry {
  key: string;
  status: DiffStatus;
  before: unknown;
  after: unknown;
}

/**
 * Compute a flat diff between `before` and `after`.
 * Handles nested objects by recursing one level (keys are dot-joined).
 * Returns only entries that are added, removed, or changed.
 */
export function computeDiff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  prefix = ""
): DiffEntry[] {
  const result: DiffEntry[] = [];

  const bef: Record<string, unknown> = before ?? {};
  const aft: Record<string, unknown> = after ?? {};

  const allKeys = new Set([...Object.keys(bef), ...Object.keys(aft)]);

  for (const key of allKeys) {
    const qualifiedKey = prefix ? `${prefix}.${key}` : key;
    const hasInBefore = Object.prototype.hasOwnProperty.call(bef, key);
    const hasInAfter = Object.prototype.hasOwnProperty.call(aft, key);

    const bVal = bef[key];
    const aVal = aft[key];

    if (!hasInBefore && hasInAfter) {
      result.push({ key: qualifiedKey, status: "added", before: undefined, after: aVal });
      continue;
    }

    if (hasInBefore && !hasInAfter) {
      result.push({ key: qualifiedKey, status: "removed", before: bVal, after: undefined });
      continue;
    }

    // Both sides have the key — recurse if both values are plain objects
    if (isPlainObject(bVal) && isPlainObject(aVal)) {
      const nested = computeDiff(
        bVal as Record<string, unknown>,
        aVal as Record<string, unknown>,
        qualifiedKey
      );
      result.push(...nested);
      continue;
    }

    // Scalar comparison — use JSON stringify for stable null/undefined distinction
    if (!strictEqual(bVal, aVal)) {
      result.push({ key: qualifiedKey, status: "changed", before: bVal, after: aVal });
    }
  }

  return result;
}

function isPlainObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function strictEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Distinguish null from undefined
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;
  // Fallback: JSON comparison for arrays / dates serialised as strings
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
