import { useState } from "react";
import { useTranslation } from "react-i18next";
import DashboardLayout from "@/components/DashboardLayout";
import InsuranceTab from "./InsuranceTab";
import ShippingTab from "./ShippingTab";
import TaxRatesTab from "./TaxRatesTab";
import RentalRulesTab from "./RentalRulesTab";
import DepositsTab from "./DepositsTab";
import InvoiceBillingTab from "./InvoiceBillingTab";
import ContractTermsTab from "./ContractTermsTab";

type TabKey = "insurance" | "depositRules" | "shipping" | "tax" | "rules" | "invoiceBilling" | "contractTerms";

export default function RentalSettings() {
  const { t } = useTranslation("admin");
  const [activeTab, setActiveTab] = useState<TabKey>("insurance");

  const TABS: { key: TabKey; label: string; icon: string }[] = [
    { key: "insurance", label: t("rentalSettings.insurance"), icon: "\uD83D\uDEE1\uFE0F" },
    { key: "depositRules", label: t("rentalSettings.depositSettings"), icon: "\uD83D\uDCB0" },
    { key: "shipping", label: t("rentalSettings.shipping"), icon: "\uD83D\uDE9A" },
    { key: "tax", label: t("rentalSettings.taxRates"), icon: "\uD83D\uDCCA" },
    { key: "rules", label: t("rentalSettings.rentalRules"), icon: "\uD83D\uDCCB" },
    { key: "invoiceBilling", label: t("rentalSettings.invoiceBilling"), icon: "\uD83D\uDCB3" },
    { key: "contractTerms", label: t("rentalSettings.contractTerms"), icon: "\uD83D\uDCC4" },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("rentalSettings.title")}</h1>
          <p className="text-sm text-slate-500 mt-1">{t("rentalSettings.subtitle")}</p>
        </div>

        {/* Tabs */}
        <div className="border-b border-slate-200">
          <nav className="flex gap-4 -mb-px overflow-x-auto">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`py-2 px-1 border-b-2 text-sm font-medium whitespace-nowrap ${
                  activeTab === tab.key
                    ? "border-[var(--primary)] text-[var(--primary)]"
                    : "border-transparent text-slate-500 hover:text-slate-700"
                }`}
              >
                <span className="mr-1.5">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Tab content */}
        {activeTab === "insurance" && <InsuranceTab />}
        {activeTab === "depositRules" && <DepositsTab />}
        {activeTab === "shipping" && <ShippingTab />}
        {activeTab === "tax" && <TaxRatesTab />}
        {activeTab === "rules" && <RentalRulesTab />}
        {activeTab === "invoiceBilling" && <InvoiceBillingTab />}
        {activeTab === "contractTerms" && <ContractTermsTab />}
      </div>
    </DashboardLayout>
  );
}
