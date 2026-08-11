import { useTranslation } from "react-i18next";
import DashboardLayout from "@/components/DashboardLayout";
import CategoryManager from "@/components/CategoryManager";

export default function CategoryManagement() {
  const { t } = useTranslation("fleet");

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("categoryManagement.title")}</h1>
          <p className="text-sm text-slate-500 mt-1">{t("categoryManagement.subtitle")}</p>
        </div>
        <div className="card">
          <CategoryManager />
        </div>
      </div>
    </DashboardLayout>
  );
}
