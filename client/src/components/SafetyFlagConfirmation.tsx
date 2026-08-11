import { canConfirmSafetyFlagChange } from "@/lib/safetyFlagConfirmation";

interface SafetyFlagConfirmationProps {
  flagLabel: string;
  enabling: boolean;
  reason: string;
  pending: boolean;
  labels: {
    warning: string;
    reason: string;
    confirm: string;
    cancel: string;
  };
  onReasonChange: (reason: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function SafetyFlagConfirmation({
  flagLabel,
  enabling,
  reason,
  pending,
  labels,
  onReasonChange,
  onConfirm,
  onCancel,
}: SafetyFlagConfirmationProps) {
  const canConfirm = canConfirmSafetyFlagChange(reason, pending);

  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <p className="text-xs font-medium text-amber-900">
        {labels.warning} {flagLabel}: {enabling ? "ON" : "OFF"}
      </p>
      <label className="mt-2 block text-xs text-amber-800" htmlFor="safety-flag-reason">
        {labels.reason}
      </label>
      <textarea
        id="safety-flag-reason"
        name="safety-flag-reason"
        value={reason}
        onChange={(event) => onReasonChange(event.target.value)}
        rows={2}
        maxLength={500}
        className="mt-1 w-full rounded border border-amber-300 bg-white px-2 py-1.5 text-sm text-slate-900"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className="btn-secondary text-xs" onClick={onCancel} disabled={pending}>
          {labels.cancel}
        </button>
        <button type="button" className="btn-primary text-xs" onClick={onConfirm} disabled={!canConfirm}>
          {labels.confirm}
        </button>
      </div>
    </div>
  );
}
