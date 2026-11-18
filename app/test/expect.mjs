// Minimal expect() for the domain tests that were written for vitest.
import assert from "node:assert/strict";

export function expect(actual) {
  return {
    toBe: (expected) => assert.strictEqual(actual, expected),
    toEqual: (expected) => assert.deepStrictEqual(actual, expected),
    toBeDefined: () => assert.notStrictEqual(actual, undefined),
    toBeUndefined: () => assert.strictEqual(actual, undefined),
    toBeTruthy: () => assert.ok(actual),
    toBeGreaterThanOrEqual: (n) => assert.ok(actual >= n, `${actual} >= ${n}`),
    toBeLessThanOrEqual: (n) => assert.ok(actual <= n, `${actual} <= ${n}`),
  };
}
