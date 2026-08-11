import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import SettingsShell from "@/components/SettingsShell";
import { trpc } from "@/lib/trpc";
import { useBranding } from "@/config/branding";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { serverErrorText } from "@/lib/serverError";

const TIMEZONE_OPTIONS = [
  "America/Toronto",
  "America/Vancouver",
  "America/Edmonton",
  "America/Winnipeg",
  "America/Halifax",
  "America/St_Johns",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Europe/London",
] as const;

type FieldDef = {
  key: string;
  tKey: string;
  type?: "color" | "email" | "tel" | "select";
  options?: readonly string[];
  placeholder?: string;
  hint?: string;
};

const fieldKeys: FieldDef[] = [
  { key: "company_name", tKey: "siteSettings.companyName" },
  { key: "tagline", tKey: "siteSettings.tagline" },
  { key: "logo_url", tKey: "siteSettings.logoUrl" },
  { key: "primary_color", tKey: "siteSettings.primaryColor", type: "color" },
  { key: "accent_color", tKey: "siteSettings.accentColor", type: "color" },
  { key: "contact_email", tKey: "siteSettings.contactEmail", type: "email" },
  { key: "contact_phone", tKey: "siteSettings.contactPhone", type: "tel" },
  { key: "sales_email", tKey: "siteSettings.salesEmail", type: "email" },
  { key: "sales_phone", tKey: "siteSettings.salesPhone", type: "tel" },
  { key: "gstHstNumber", tKey: "siteSettings.gstHstNumber", placeholder: "siteSettings.gstHstPlaceholder", hint: "siteSettings.gstHstHint" },
  { key: "address", tKey: "siteSettings.address" },
  { key: "domain", tKey: "siteSettings.domain" },
  { key: "timezone", tKey: "siteSettings.timezone", type: "select", options: TIMEZONE_OPTIONS, hint: "siteSettings.timezoneHint" },
];

export default function SiteSettings() {
  const { t } = useTranslation("admin");
  const _branding = useBranding();
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.siteSettings.getAll.useQuery();
  const bulkUpdate = trpc.siteSettings.bulkUpdate.useMutation({
    onSuccess: () => {
      utils.siteSettings.getAll.invalidate();
      toast.success(t("siteSettings.saved"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data) {
      const initial: Record<string, string> = {};
      for (const f of fieldKeys) {
        initial[f.key] = (data as Record<string, string>)[f.key] || "";
      }
      setForm(initial);
    }
  }, [data]);

  const handleSave = () => {
    const updates: Record<string, string> = {};
    for (const [key, value] of Object.entries(form)) {
      if (value) updates[key] = value;
    }
    bulkUpdate.mutate(updates);
  };

  const inputClass = "flex-1 bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm";

  return (
    <SettingsShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("siteSettings.title")}</h1>
          <button onClick={handleSave} disabled={bulkUpdate.isPending} className="btn-primary flex items-center gap-2">
            <Save size={18} />
            {bulkUpdate.isPending ? t("siteSettings.saveChanges") + "..." : t("siteSettings.saveChanges")}
          </button>
        </div>

        {isLoading ? <div className="flex items-center justify-center py-12"><div className="spinner" /><span className="ml-3 text-sm text-slate-500">{t("loading", { ns: "common" })}</span></div> : (
          <div className="card space-y-4">
            {fieldKeys.map((f) => (
              <div key={f.key} className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-center">
                <label className="text-sm font-medium text-slate-500">{t(f.tKey as never)}</label>
                <div className="sm:col-span-2 flex items-center gap-2">
                  {f.type === "color" && (
                    <input
                      type="color"
                      value={form[f.key] || "#000000"}
                      onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                      className="w-10 h-10 rounded border border-slate-300 bg-transparent cursor-pointer"
                    />
                  )}
                  {f.type === "select" ? (
                    <select
                      value={form[f.key] || (f.options?.[0] ?? "")}
                      onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                      className={inputClass}
                    >
                      {f.options?.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={f.type === "color" ? "text" : f.type || "text"}
                      value={form[f.key] || ""}
                      onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                      placeholder={f.placeholder ? t(f.placeholder as never) : t(f.tKey as never)}
                      className={inputClass}
                    />
                  )}
                </div>
                {f.hint && (
                  <p className="sm:col-span-2 sm:col-start-2 text-xs text-slate-500 mt-1">{t(f.hint as never)}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </SettingsShell>
  );
}
