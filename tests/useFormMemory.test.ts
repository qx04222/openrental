import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Minimal localStorage mock for the node test environment
// ---------------------------------------------------------------------------
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string): string | null => store[key] ?? null,
  setItem: (key: string, value: string): void => {
    store[key] = value;
  },
  removeItem: (key: string): void => {
    delete store[key];
  },
  clear: (): void => {
    Object.keys(store).forEach((k) => delete store[k]);
  },
};

// Inject the mock before the module is imported
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
});

// Import AFTER the mock is in place
import { useFormMemory } from "../client/src/hooks/useFormMemory";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rawRead(key: string): string[] {
  const raw = localStorageMock.getItem(`form-memory:${key}`);
  if (!raw) return [];
  return JSON.parse(raw) as string[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useFormMemory", () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  it("returns empty suggestions when no data stored", () => {
    const { suggestions } = useFormMemory("test-key");
    expect(suggestions).toEqual([]);
  });

  it("remember() stores a value", () => {
    const { remember } = useFormMemory("test-key");
    remember("hello");
    const { suggestions } = useFormMemory("test-key");
    expect(suggestions).toContain("hello");
  });

  it("remember() trims whitespace before storing", () => {
    const { remember } = useFormMemory("test-key");
    remember("  hello  ");
    const { suggestions } = useFormMemory("test-key");
    expect(suggestions).toContain("hello");
    expect(suggestions).not.toContain("  hello  ");
  });

  it("remember() ignores empty/whitespace-only values", () => {
    const { remember } = useFormMemory("test-key");
    remember("");
    remember("   ");
    const { suggestions } = useFormMemory("test-key");
    expect(suggestions).toHaveLength(0);
  });

  it("adds most-recent entry to the front", () => {
    const { remember } = useFormMemory("test-key");
    remember("first");
    remember("second");
    const { suggestions } = useFormMemory("test-key");
    expect(suggestions[0]).toBe("second");
    expect(suggestions[1]).toBe("first");
  });

  it("deduplicates: moves existing value to front", () => {
    const { remember } = useFormMemory("test-key");
    remember("alpha");
    remember("beta");
    remember("alpha"); // duplicate — should move to front
    const { suggestions } = useFormMemory("test-key");
    expect(suggestions[0]).toBe("alpha");
    expect(suggestions.filter((v) => v === "alpha")).toHaveLength(1);
  });

  it("caps at max (default 10)", () => {
    const { remember } = useFormMemory("test-key");
    for (let i = 1; i <= 15; i++) {
      remember(`value-${i}`);
    }
    const { suggestions } = useFormMemory("test-key");
    expect(suggestions).toHaveLength(10);
    // Most recent entry should be at front
    expect(suggestions[0]).toBe("value-15");
    // Oldest entries are dropped
    expect(suggestions).not.toContain("value-1");
    expect(suggestions).not.toContain("value-5");
  });

  it("respects custom max", () => {
    const { remember } = useFormMemory("test-key", 3);
    remember("a");
    remember("b");
    remember("c");
    remember("d");
    const { suggestions } = useFormMemory("test-key", 3);
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]).toBe("d");
  });

  it("clear() removes all suggestions", () => {
    const { remember, clear, suggestions } = useFormMemory("test-key");
    remember("one");
    remember("two");
    clear();
    expect(suggestions).toHaveLength(0);
  });

  it("handles malformed localStorage JSON gracefully", () => {
    localStorageMock.setItem("form-memory:bad-key", "{{{not json}}}");
    const { suggestions } = useFormMemory("bad-key");
    expect(suggestions).toEqual([]);
  });

  it("handles localStorage returning a non-array JSON value", () => {
    localStorageMock.setItem("form-memory:obj-key", JSON.stringify({ a: 1 }));
    const { suggestions } = useFormMemory("obj-key");
    expect(suggestions).toEqual([]);
  });

  it("filters out non-string entries from stored array", () => {
    localStorageMock.setItem(
      "form-memory:mixed-key",
      JSON.stringify(["valid", 42, null, true, "also-valid"])
    );
    const { suggestions } = useFormMemory("mixed-key");
    expect(suggestions).toEqual(["valid", "also-valid"]);
  });

  it("uses separate namespace per key", () => {
    const { remember } = useFormMemory("key-a");
    remember("value-for-a");
    const { suggestions: suggestionsA } = useFormMemory("key-a");
    const { suggestions: suggestionsB } = useFormMemory("key-b");
    expect(suggestionsB).toHaveLength(0);
    expect(suggestionsA).toContain("value-for-a");
  });

  it("handles quota exceeded error silently", () => {
    const originalSetItem = localStorageMock.setItem;
    localStorageMock.setItem = () => {
      throw new DOMException("QuotaExceededError");
    };
    const { remember } = useFormMemory("quota-key");
    expect(() => remember("value")).not.toThrow();
    localStorageMock.setItem = originalSetItem;
  });

  it("handles localStorage unavailable (undefined) gracefully", () => {
    const original = globalThis.localStorage;
    // @ts-expect-error — intentionally setting to undefined for the test
    globalThis.localStorage = undefined;
    try {
      const { remember, suggestions, clear } = useFormMemory("no-storage");
      expect(suggestions).toEqual([]);
      expect(() => remember("x")).not.toThrow();
      expect(() => clear()).not.toThrow();
    } finally {
      globalThis.localStorage = original;
    }
  });
});
