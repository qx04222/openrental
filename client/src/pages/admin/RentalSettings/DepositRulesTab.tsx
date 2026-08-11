import { useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, X } from "lucide-react";
import { serverErrorText } from "@/lib/serverError";

interface RuleForm {
  category: string;
  depositType: "percentage" | "fixed";
  value: string;
  minDeposit: string;
  maxDeposit: string;
  priority: number;
}

type DepositRule = RouterOutputs["depositRules"]["list"][number];

const emptyForm: RuleForm = {
  category: "",
  depositType: "percentage",
  value: "0.20",
  minDeposit: "500",
  maxDeposit: "",
  priority: 100,
};

export default function DepositRulesTab() {
  const { t } = useTranslation("admin");
  const { data: rules, refetch } = trpc.depositRules.list.useQuery();
  const createRule = trpc.depositRules.create.useMutation({
    onSuccess: () => { refetch(); toast.success(t("depositRules.createSuccess")); setDialogOpen(false); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const updateRule = trpc.depositRules.update.useMutation({
    onSuccess: () => { refetch(); toast.success(t("depositRules.updateSuccess")); setDialogOpen(false); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const deleteRule = trpc.depositRules.delete.useMutation({
    onSuccess: () => { refetch(); toast.success(t("depositRules.deleteSuccess")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<RuleForm>(emptyForm);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (rule: DepositRule) => {
    setEditingId(rule.id);
    setForm({
      category: rule.category,
      depositType: rule.depositType as "percentage" | "fixed",
      value: rule.value,
      minDeposit: rule.minDeposit,
      maxDeposit: rule.maxDeposit || "",
      priority: rule.priority,
    });
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!form.category.trim()) {
      toast.error(t("depositRules.categoryRequired"));
      return;
    }
    const payload = {
      category: form.category.trim(),
      depositType: form.depositType,
      value: form.value,
      minDeposit: form.minDeposit || "500",
      maxDeposit: form.maxDeposit || undefined,
      priority: form.priority,
    };

    if (editingId) {
      updateRule.mutate({ id: editingId, ...payload });
    } else {
      createRule.mutate(payload);
    }
  };

  const handleDelete = (id: number) => {
    deleteRule.mutate({ id });
    setConfirmDeleteId(null);
  };

  const formatValue = (rule: DepositRule) => {
    if (rule.depositType === "percentage") {
      return `${(parseFloat(rule.value) * 100).toFixed(0)}%`;
    }
    return `$${parseFloat(rule.value).toLocaleString()}`;
  };

  const formatCurrency = (val: string | null) => {
    if (!val) return "-";
    return `$${parseFloat(val).toLocaleString()}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">{t("depositRules.sectionTitle")}</h3>
          <p className="text-sm text-slate-500 mt-1">
            {t("depositRules.sectionDescription")}
          </p>
        </div>
        <button
          onClick={openCreate}
          className="btn-primary text-sm flex items-center gap-1.5"
        >
          <Plus size={16} />
          {t("depositRules.addRuleButton")}
        </button>
      </div>

      {/* Rules table */}
      <div className="rounded-xl border border-slate-200 shadow-sm bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-4 py-3 font-medium text-slate-600">{t("depositRules.columnCategory")}</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">{t("depositRules.columnType")}</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">{t("depositRules.columnValue")}</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">{t("depositRules.columnMinDeposit")}</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">{t("depositRules.columnMaxDeposit")}</th>
                <th className="text-center px-4 py-3 font-medium text-slate-600">{t("depositRules.columnPriority")}</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">{t("depositRules.columnActions")}</th>
              </tr>
            </thead>
            <tbody>
              {rules && rules.length > 0 ? (
                rules.map((rule) => (
                  <tr key={rule.id} className="border-b border-slate-100 hover:bg-slate-50 transition">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        rule.category === "*"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-slate-100 text-slate-700"
                      }`}>
                        {rule.category === "*" ? t("depositRules.defaultLabel") : rule.category}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-700 capitalize">{rule.depositType}</td>
                    <td className="px-4 py-3 text-right font-mono text-slate-900">{formatValue(rule)}</td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">{formatCurrency(rule.minDeposit)}</td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">{formatCurrency(rule.maxDeposit)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center px-2 py-0.5 rounded bg-slate-100 text-xs font-mono text-slate-600">
                        {rule.priority}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(rule)}
                          className="p-1.5 hover:bg-slate-100 rounded-lg transition text-slate-500 hover:text-slate-700"
                          title={t("depositRules.editTooltip")}
                        >
                          <Pencil size={14} />
                        </button>
                        {confirmDeleteId === rule.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleDelete(rule.id)}
                              className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
                            >
                              {t("depositRules.confirmDeleteButton")}
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2 py-1 text-xs text-slate-600 hover:text-slate-800"
                            >
                              {t("depositRules.cancelButton")}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmDeleteId(rule.id)}
                            className="p-1.5 hover:bg-red-50 rounded-lg transition text-slate-400 hover:text-red-600"
                            title={t("depositRules.deleteTooltip")}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    {t("depositRules.noRulesFound")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Info card */}
      <div className="rounded-xl border border-slate-200 bg-blue-50 p-4">
        <p className="text-sm text-blue-800">
          <strong>{t("depositRules.howItWorksTitle")}</strong> {t("depositRules.howItWorksText")}
        </p>
      </div>

      {/* Create/Edit Dialog */}
      {dialogOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-xl w-full max-w-lg mx-4">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">
                {editingId ? t("depositRules.editDialogTitle") : t("depositRules.createDialogTitle")}
              </h3>
              <button onClick={() => setDialogOpen(false)} className="p-1.5 hover:bg-slate-100 rounded-lg transition">
                <X size={18} />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {/* Category */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("depositRules.formCategory")}</label>
                <input
                  type="text"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder={t("depositRules.categoryPlaceholder")}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                />
                <p className="text-xs text-slate-500 mt-1">{t("depositRules.categoryHint")}</p>
              </div>

              {/* Type */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("depositRules.formDepositType")}</label>
                <select
                  value={form.depositType}
                  onChange={(e) => setForm({ ...form, depositType: e.target.value as "percentage" | "fixed" })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                >
                  <option value="percentage">{t("depositRules.percentageOption")}</option>
                  <option value="fixed">{t("depositRules.fixedOption")}</option>
                </select>
              </div>

              {/* Value */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  {form.depositType === "percentage" ? t("depositRules.formValuePercentage") : t("depositRules.formValueFixed")}
                </label>
                <input
                  type="text"
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                  placeholder={form.depositType === "percentage" ? "0.20" : "5000"}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                />
              </div>

              {/* Min / Max Deposit */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("depositRules.formMinDeposit")}</label>
                  <input
                    type="text"
                    value={form.minDeposit}
                    onChange={(e) => setForm({ ...form, minDeposit: e.target.value })}
                    placeholder="500"
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("depositRules.formMaxDeposit")}</label>
                  <input
                    type="text"
                    value={form.maxDeposit}
                    onChange={(e) => setForm({ ...form, maxDeposit: e.target.value })}
                    placeholder={t("depositRules.maxDepositPlaceholder")}
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                  />
                </div>
              </div>

              {/* Priority */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("depositRules.formPriority")}</label>
                <input
                  type="number"
                  min={0}
                  max={9999}
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: parseInt(e.target.value) || 0 })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                />
                <p className="text-xs text-slate-500 mt-1">{t("depositRules.priorityHint")}</p>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2">
              <button
                onClick={() => setDialogOpen(false)}
                className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800"
              >
                {t("depositRules.cancelButton")}
              </button>
              <button
                onClick={handleSave}
                disabled={createRule.isPending || updateRule.isPending}
                className="btn-primary text-sm"
              >
                {createRule.isPending || updateRule.isPending ? t("depositRules.saving") : editingId ? t("depositRules.updateRuleButton") : t("depositRules.createRuleButton")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
