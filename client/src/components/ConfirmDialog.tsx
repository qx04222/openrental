import { useState, useEffect, useRef } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  dangerous?: boolean;
  requireTypedConfirmation?: string;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  dangerous = false,
  requireTypedConfirmation,
  onConfirm,
}: ConfirmDialogProps) {
  const [typedValue, setTypedValue] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset typed value whenever the dialog opens
  useEffect(() => {
    if (open) {
      setTypedValue("");
      setLoading(false);
    }
  }, [open]);

  // Focus the input after dialog opens
  useEffect(() => {
    if (open && requireTypedConfirmation && inputRef.current) {
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open, requireTypedConfirmation]);

  const isConfirmEnabled =
    !loading &&
    (!requireTypedConfirmation || typedValue === requireTypedConfirmation);

  const handleConfirm = async () => {
    if (!isConfirmEnabled) return;
    setLoading(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    if (loading) return;
    onOpenChange(false);
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => { if (!loading) onOpenChange(o); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-xl focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]">
          <AlertDialog.Title className="text-base font-semibold text-slate-900">
            {title}
          </AlertDialog.Title>

          {description && (
            <AlertDialog.Description className="mt-2 text-sm text-slate-600">
              {description}
            </AlertDialog.Description>
          )}

          {requireTypedConfirmation && (
            <div className="mt-4">
              <p className="mb-2 text-sm text-slate-600">
                Type{" "}
                <span className="font-mono font-semibold text-slate-900">
                  {requireTypedConfirmation}
                </span>{" "}
                to confirm:
              </p>
              <input
                ref={inputRef}
                type="text"
                value={typedValue}
                onChange={(e) => setTypedValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleConfirm();
                }}
                disabled={loading}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 disabled:opacity-50"
                placeholder={requireTypedConfirmation}
                aria-label={`Type ${requireTypedConfirmation} to confirm`}
              />
            </div>
          )}

          <div className="mt-6 flex justify-end gap-3">
            <AlertDialog.Cancel asChild>
              <button
                onClick={handleCancel}
                disabled={loading}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 disabled:opacity-50"
              >
                {cancelLabel}
              </button>
            </AlertDialog.Cancel>

            <AlertDialog.Action asChild>
              <button
                onClick={handleConfirm}
                disabled={!isConfirmEnabled}
                className={`rounded-md px-4 py-2 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
                  dangerous
                    ? "bg-red-600 hover:bg-red-700 focus:ring-red-500"
                    : "bg-slate-800 hover:bg-slate-900 focus:ring-slate-500"
                }`}
              >
                {loading ? "Loading..." : confirmLabel}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
