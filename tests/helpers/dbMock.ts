/**
 * Shared DB mock builder — used by router/service unit tests to avoid
 * real DATABASE_URL dependency and to keep tests deterministic.
 *
 * Usage:
 *   const { mockDb, setSelect, setInsert } = createDbMock();
 *   vi.mock("../server/db", () => ({ getDb: async () => mockDb, ... }));
 *
 * Do NOT use this for integration tests against a real database.
 */
import { vi } from "vitest";

export interface DbMock {
  mockDb: Record<string, unknown>;
  setSelectResult: (rows: unknown[]) => void;
  setInsertResult: (rows: unknown[]) => void;
  setUpdateResult: (rows: unknown[]) => void;
  reset: () => void;
}

export function createDbMock(): DbMock {
  const state = {
    selectRows: [] as unknown[],
    insertRows: [] as unknown[],
    updateRows: [] as unknown[],
  };

  const chain = <T>(result: () => T) => {
    const p: Record<string, () => unknown> & PromiseLike<T> = {} as never;
    const fn = () => p;
    p.from = fn;
    p.where = fn;
    p.orderBy = fn;
    p.limit = fn;
    p.offset = fn;
    p.leftJoin = fn;
    p.innerJoin = fn;
    p.groupBy = fn;
    p.returning = () => Promise.resolve(result());
    p.then = (onFulfilled?: (value: T) => unknown) => Promise.resolve(result()).then(onFulfilled);
    return p;
  };

  const mockDb = {
    select: vi.fn(() => chain(() => state.selectRows)),
    insert: vi.fn(() => ({
      values: () => ({
        returning: () => Promise.resolve(state.insertRows),
        onConflictDoNothing: () => Promise.resolve(state.insertRows),
        onConflictDoUpdate: () => Promise.resolve(state.insertRows),
      }),
    })),
    update: vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(state.updateRows),
          then: (onFulfilled?: (value: unknown) => unknown) =>
            Promise.resolve(state.updateRows).then(onFulfilled),
        }),
      }),
    })),
    delete: vi.fn(() => ({
      where: () => Promise.resolve({ count: 0 }),
    })),
    transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) => fn(mockDb)),
  };

  return {
    mockDb,
    setSelectResult: (rows) => { state.selectRows = rows; },
    setInsertResult: (rows) => { state.insertRows = rows; },
    setUpdateResult: (rows) => { state.updateRows = rows; },
    reset: () => {
      state.selectRows = [];
      state.insertRows = [];
      state.updateRows = [];
      vi.clearAllMocks();
    },
  };
}
