/**
 * Imperative confirmation hook backed by a module-level event emitter.
 * Usage:
 *   const confirm = useConfirm();
 *   const ok = await confirm({ title: "Delete?", dangerous: true });
 *   if (ok) { ... }
 *
 * Requires <ConfirmProvider> to be mounted (e.g. in DashboardLayout).
 * When the 'confirm_dialog' feature flag is OFF, falls back to window.confirm().
 */

import { useCallback } from "react";
import type { ConfirmOptions } from "@/components/ConfirmProvider";

// ---------------------------------------------------------------------------
// Module-level event bus — shared between useConfirm callers and ConfirmProvider
// ---------------------------------------------------------------------------

type ConfirmRequest = ConfirmOptions & {
  resolve: (value: boolean) => void;
};

type ConfirmListener = (request: ConfirmRequest) => void;

const listeners: Set<ConfirmListener> = new Set();

export function subscribeToConfirm(listener: ConfirmListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitConfirm(request: ConfirmRequest): void {
  for (const l of listeners) {
    l(request);
  }
}

// ---------------------------------------------------------------------------
// Feature flag helper (reads from localStorage for client-side gating)
// ---------------------------------------------------------------------------

function isConfirmDialogEnabled(): boolean {
  try {
    const raw = localStorage.getItem("feature_flags");
    if (!raw) return true; // default ON
    const flags = JSON.parse(raw) as Record<string, boolean>;
    return flags["confirm_dialog"] !== false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useConfirm() {
  const confirm = useCallback(
    (options: ConfirmOptions): Promise<boolean> => {
      if (!isConfirmDialogEnabled()) {
        // Fallback to native confirm
        const message = [options.title, options.description]
          .filter(Boolean)
          .join("\n");
        return Promise.resolve(window.confirm(message));
      }

      return new Promise<boolean>((resolve) => {
        if (listeners.size === 0) {
          // ConfirmProvider not mounted — fall back without interrupting the user.
          const message = [options.title, options.description]
            .filter(Boolean)
            .join("\n");
          resolve(window.confirm(message));
          return;
        }
        emitConfirm({ ...options, resolve });
      });
    },
    []
  );

  return confirm;
}
