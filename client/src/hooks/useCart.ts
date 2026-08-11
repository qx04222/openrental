import { useEffect, useState, useCallback } from "react";

/**
 * A single cart item. The customer commits to a specific group (model) at
 * add-time; specific fleet IDs are picked at submit time from the available
 * pool the server returns. Quantity stays per-item so the same model can be
 * batched (e.g. "2 of model X").
 */
export interface CartItem {
  groupKey: string;
  equipmentModelId: number | null;
  equipmentType: "machine" | "attachment";
  brand: string;
  model: string;
  category: string | null;
  imageUrl: string | null;
  /** Available fleet IDs at the moment of adding to cart. Refreshed on submit. */
  availableFleetIds: number[];
  quantity: number;
  dailyRate: string | null;
  weeklyRate: string | null;
  monthlyRate: string | null;
  /** Attachment-only — captures customer's own machine when buying solo */
  customerEquipmentNote?: string;
  compatibilityAcknowledged?: boolean;
  /** Per-line date overrides — null/undefined means use the order's shared dates. */
  startDate?: string | null;
  endDate?: string | null;
}

const STORAGE_KEY = "openrental-cart-v1";

function readStorage(): CartItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStorage(items: CartItem[]) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch { /* quota */ }
}

// Cross-instance sync: each hook user listens for changes broadcast by others
// (storage event for other tabs + a custom event for same-tab consumers).
const CART_EVENT = "openrental-cart-updated";

export function useCart() {
  const [items, setItems] = useState<CartItem[]>(() => readStorage());

  useEffect(() => {
    const refresh = () => setItems(readStorage());
    window.addEventListener("storage", refresh);
    window.addEventListener(CART_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(CART_EVENT, refresh);
    };
  }, []);

  const persist = useCallback((next: CartItem[]) => {
    writeStorage(next);
    setItems(next);
    window.dispatchEvent(new Event(CART_EVENT));
  }, []);

  const addItem = useCallback((item: Omit<CartItem, "quantity"> & { quantity?: number }) => {
    const next = [...readStorage()];
    const idx = next.findIndex((i) => i.groupKey === item.groupKey);
    if (idx >= 0) {
      const cap = item.availableFleetIds.length || 1;
      const newQty = Math.min(cap, next[idx].quantity + (item.quantity ?? 1));
      next[idx] = { ...next[idx], ...item, quantity: newQty, availableFleetIds: item.availableFleetIds };
    } else {
      next.push({ ...item, quantity: item.quantity ?? 1 });
    }
    persist(next);
  }, [persist]);

  const updateQuantity = useCallback((groupKey: string, qty: number) => {
    const next = readStorage().map((i) =>
      i.groupKey === groupKey
        ? { ...i, quantity: Math.max(1, Math.min(i.availableFleetIds.length || 1, qty)) }
        : i,
    );
    persist(next);
  }, [persist]);

  const updateItem = useCallback((groupKey: string, patch: Partial<CartItem>) => {
    const next = readStorage().map((i) => i.groupKey === groupKey ? { ...i, ...patch } : i);
    persist(next);
  }, [persist]);

  const removeItem = useCallback((groupKey: string) => {
    persist(readStorage().filter((i) => i.groupKey !== groupKey));
  }, [persist]);

  const clear = useCallback(() => persist([]), [persist]);

  return {
    items,
    count: items.reduce((s, i) => s + i.quantity, 0),
    addItem,
    updateQuantity,
    updateItem,
    removeItem,
    clear,
  };
}
