import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import SettingsShell from "@/components/SettingsShell";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import SafetyFlagConfirmation from "@/components/SafetyFlagConfirmation";
import { isRentalOperationSafetyFlag } from "@shared/rentalOperationPolicies";
import { serverErrorText } from "@/lib/serverError";

// Grouping drives the rendered sections. Order mirrors the rollout phases.
const GROUPS: Array<{ key: "phase1" | "phase2" | "phase3" | "phase4" | "phase5"; flags: string[] }> = [
  { key: "phase1", flags: ["form_memory", "confirm_dialog", "global_search", "batch_operations"] },
  { key: "phase2", flags: ["today_dashboard", "customer_360", "utilization_dashboard", "audit_log_search"] },
  { key: "phase3", flags: ["rental_duplicate", "conflict_warning", "customer_segmentation"] },
  { key: "phase4", flags: ["rental_renewal", "late_fee_auto", "credit_limit", "birthday_greetings", "signature_evidence"] },
  { key: "phase5", flags: ["mid_rental_swap", "rolling_renewal_operations", "dispatch_workflow", "dispatch_inspection_required", "return_inspection_required"] },
];

export default function FeatureFlags() {
  const { t } = useTranslation("common");
  const { data: me } = trpc.users.me.useQuery();
  const utils = trpc.useUtils();
  const [safetyChange, setSafetyChange] = useState<{ key: string; enabled: boolean } | null>(null);
  const [safetyReason, setSafetyReason] = useState("");
  const { data: flags, isLoading } = trpc.featureFlags.list.useQuery();
  const setEnabled = trpc.featureFlags.setEnabled.useMutation({
    onSuccess: () => {
      utils.featureFlags.list.invalidate();
      utils.featureFlags.isEnabled.invalidate();
      utils.featureFlags.allEnabled.invalidate();
      setSafetyChange(null);
      setSafetyReason("");
      toast.success(t("featureFlags.toastUpdated"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const byKey = useMemo(() => {
    const map = new Map<string, { id: number; key: string; enabled: boolean }>();
    (flags ?? []).forEach((f) => map.set(f.key, f));
    return map;
  }, [flags]);

  if (me && me.role !== "super_admin") {
    return (
      <SettingsShell>
        <div className="p-6">
          <div className="max-w-xl mx-auto bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle size={20} className="text-amber-600 mt-0.5" />
            <div className="text-sm text-amber-900">{t("featureFlags.superAdminOnly")}</div>
          </div>
        </div>
      </SettingsShell>
    );
  }

  return (
    <SettingsShell>
      <div className="p-6 max-w-4xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">{t("featureFlags.title")}</h1>
          <p className="text-sm text-slate-500 mt-1">{t("featureFlags.subtitle")}</p>
        </div>

        {isLoading && <div className="text-slate-500">{t("featureFlags.loading")}</div>}

        {!isLoading && GROUPS.map((group) => (
          <section key={group.key} className="mb-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-2">
              {t(`featureFlags.group.${group.key}` as never) as string}
            </h2>
            <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
              {group.flags.map((key) => {
                const flag = byKey.get(key);
                // i18n keys are dynamic — cast for the strict i18next key type
                const name = t(`featureFlags.name.${key}` as never) as string;
                const desc = t(`featureFlags.desc.${key}` as never) as string;
                if (!flag) {
                  return (
                    <div key={key} className="p-4 flex items-center justify-between opacity-60">
                      <div>
                        <div className="font-medium text-slate-900">{name}</div>
                        <div className="text-[11px] font-mono text-slate-400 mt-0.5">{key}</div>
                        <div className="text-xs text-slate-500 mt-1">{t("featureFlags.rowMissing")}</div>
                      </div>
                      <span className="text-xs text-slate-400">{t("featureFlags.unavailable")}</span>
                    </div>
                  );
                }
                const pending = setEnabled.isPending && setEnabled.variables?.key === flag.key;
                const confirming = safetyChange?.key === flag.key;
                return (
                  <div key={flag.key} className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="font-medium text-slate-900">{name}</div>
                        <div className="text-[11px] font-mono text-slate-400 mt-0.5">{flag.key}</div>
                        <div className="text-xs text-slate-500 mt-1">{desc}</div>
                      </div>
                      <button
                        onClick={() => {
                          const enabled = !flag.enabled;
                          if (isRentalOperationSafetyFlag(flag.key)) {
                            setSafetyChange({ key: flag.key, enabled });
                            setSafetyReason("");
                          } else {
                            setEnabled.mutate({ key: flag.key, enabled });
                          }
                        }}
                        disabled={pending}
                        role="switch"
                        aria-checked={flag.enabled}
                        className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                          flag.enabled ? "bg-emerald-500" : "bg-slate-300"
                        }`}
                      >
                        <span
                          className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform ${
                            flag.enabled ? "translate-x-5" : "translate-x-0.5"
                          } mt-0.5`}
                        />
                      </button>
                    </div>
                    {confirming && (
                      <SafetyFlagConfirmation
                        flagLabel={name}
                        enabling={safetyChange.enabled}
                        reason={safetyReason}
                        pending={pending}
                        labels={{
                          warning: t("featureFlags.safetyWarning"),
                          reason: t("featureFlags.changeReason"),
                          confirm: t("featureFlags.confirmChange"),
                          cancel: t("cancel"),
                        }}
                        onReasonChange={setSafetyReason}
                        onConfirm={() => setEnabled.mutate({
                          key: safetyChange.key,
                          enabled: safetyChange.enabled,
                          reason: safetyReason.trim(),
                        })}
                        onCancel={() => { setSafetyChange(null); setSafetyReason(""); }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </SettingsShell>
  );
}
