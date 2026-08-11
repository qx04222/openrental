/**
 * ConfirmProvider
 * Mount once in DashboardLayout (or another layout root) to enable the
 * imperative useConfirm() hook throughout the subtree.
 */

import { ReactNode, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { subscribeToConfirm } from "@/hooks/useConfirm";

// Re-exported so useConfirm.ts can import the type without a circular dep
export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  dangerous?: boolean;
  requireTypedConfirmation?: string;
}

interface DialogState extends ConfirmOptions {
  open: boolean;
  resolve: (value: boolean) => void;
}

const noop = (_: boolean): void => {};

const CLOSED_STATE: DialogState = {
  open: false,
  title: "",
  resolve: noop,
};

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>(CLOSED_STATE);

  useEffect(() => {
    const unsubscribe = subscribeToConfirm((request) => {
      const { resolve, ...options } = request;
      setState({ ...options, open: true, resolve });
    });
    return unsubscribe;
  }, []);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      // User dismissed — resolve false
      state.resolve(false);
      setState(CLOSED_STATE);
    }
  };

  const handleConfirm = () => {
    state.resolve(true);
    setState(CLOSED_STATE);
  };

  return (
    <>
      {children}
      <ConfirmDialog
        open={state.open}
        onOpenChange={handleOpenChange}
        title={state.title}
        description={state.description}
        confirmLabel={state.confirmLabel}
        cancelLabel={state.cancelLabel}
        dangerous={state.dangerous}
        requireTypedConfirmation={state.requireTypedConfirmation}
        onConfirm={handleConfirm}
      />
    </>
  );
}
