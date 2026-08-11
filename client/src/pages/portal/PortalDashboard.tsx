import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import PortalLayout from "./PortalLayout";
import { Package, Receipt, Wallet, ArrowRight } from "lucide-react";
import { formatCurrency } from "@/lib/pricing";

export default function PortalDashboard() {
  const { t } = useTranslation("portal");
  const { data: dashboard, isLoading } = trpc.customerPortal.dashboard.useQuery();

  const stats = [
    {
      label: t("dashboard.activeRentals"),
      value: dashboard?.activeRentals ?? 0,
      icon: Package,
      color: "text-blue-600 bg-blue-50",
    },
    {
      label: t("dashboard.pendingInvoices"),
      value: dashboard?.unpaidInvoices ?? 0,
      icon: Receipt,
      color: "text-amber-600 bg-amber-50",
    },
    {
      label: t("dashboard.depositBalance"),
      value: formatCurrency(Number(dashboard?.depositBalance ?? 0)),
      icon: Wallet,
      color: "text-green-600 bg-green-50",
    },
  ];

  return (
    <PortalLayout>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-slate-900">{t("dashboard.title")}</h1>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div key={stat.label} className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${stat.color}`}>
                    <Icon size={20} />
                  </div>
                  <div>
                    <p className="text-sm text-slate-500">{stat.label}</p>
                    <p className="text-2xl font-bold text-slate-900">
                      {isLoading ? "..." : stat.value}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Quick Links */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Link
            href="/portal/orders"
            className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5 hover:border-[#2563EB]/30 hover:shadow-sm transition group"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Package className="text-slate-400 group-hover:text-[var(--primary)] transition" size={22} />
                <span className="font-medium text-slate-900">{t("dashboard.viewOrders")}</span>
              </div>
              <ArrowRight className="text-slate-300 group-hover:text-[var(--primary)] transition" size={18} />
            </div>
          </Link>
          <Link
            href="/portal/invoices"
            className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5 hover:border-[#2563EB]/30 hover:shadow-sm transition group"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Receipt className="text-slate-400 group-hover:text-[var(--primary)] transition" size={22} />
                <span className="font-medium text-slate-900">{t("dashboard.viewInvoices")}</span>
              </div>
              <ArrowRight className="text-slate-300 group-hover:text-[var(--primary)] transition" size={18} />
            </div>
          </Link>
        </div>
      </div>
    </PortalLayout>
  );
}
