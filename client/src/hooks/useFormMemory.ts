const STORAGE_PREFIX = "form-memory:";

function readStorage(key: string): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function writeStorage(key: string, values: string[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(values));
  } catch {
    // Quota exceeded or storage unavailable — silently ignore
  }
}

export interface UseFormMemoryResult {
  suggestions: string[];
  remember: (value: string) => void;
  clear: () => void;
}

export function useFormMemory(key: string, max = 10): UseFormMemoryResult {
  // We purposely do NOT use React state so we avoid re-renders on every
  // keystroke. The datalist is re-read from localStorage on next mount.
  // This keeps the hook simple and free of React imports (pure TS utility).

  function remember(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    const existing = readStorage(key);
    const deduped = existing.filter((v) => v !== trimmed);
    const next = [trimmed, ...deduped].slice(0, max);
    writeStorage(key, next);
  }

  function clear(): void {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
      }
    } catch {
      // ignore
    }
  }

  return {
    suggestions: readStorage(key),
    remember,
    clear,
  };
}
