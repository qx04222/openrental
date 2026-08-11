import { useRoute, Link } from "wouter";
import { useTranslation } from "react-i18next";
import * as Tabs from "@radix-ui/react-tabs";
import DashboardLayout from "@/components/DashboardLayout";
import CustomerProfileDialog from "@/components/CustomerProfileDialog";
import CustomerCreditPanel from "@/components/CustomerCreditPanel";
import { trpc } from "@/lib/trpc";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";
import { formatCurrency } from "@/lib/pricing";
import { rentalStatusColors } from "@/lib/statusColors";
import { ArrowLeft, User, Calendar, DollarSign, TrendingUp, Clock, FileText, MessageSquare, Package } from "lucide-react";
import { useState } from "react";
import { useFormatCalendarDate } from "@/lib/dateUtils";
import { translateDynamic } from "@/lib/i18nHelpers";

// ── KPI Card ────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  icon: Icon,
  colorClass,
}: {
  label: string;
  value: string | number;
  icon: typeof DollarSign;
  colorClass: string;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col gap-2 shadow-sm">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${colorClass}`}>
        <Icon size={18} className="text-white" />
      </div>
      <div className="text-2xl font-bold text-slate-900">{value}</div>
      <div className="text-sm text-slate-500">{label}</div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CustomerDetail() {
  const { t } = useTranslation(["admin", "common"]);
  const [, params] = useRoute("/admin/customers/:id");
  const id = Number(params?.id);

  const customer360Enabled = useFeatureFlag("customer_360");

  // Legacy fallback state
  const [legacyOpen, setLegacyOpen] = useState(true);

  // 360 data — only fetched when flag is on and id is valid
  const { data, isLoading, error } = trpc.customers.getFullProfile.useQuery(
    { id },
    { enabled: customer360Enabled && !Number.isNaN(id) && id > 0 }
  );

  const fmtDate = useFormatCalendarDate();

  // ── Feature flag off — show legacy dialog over a blank shell ────────────────
  if (!customer360Enabled) {
    return (
      <DashboardLayout>
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Customer 360 view is not enabled. Showing legacy profile.
          </div>
          <Link href="/admin/customers" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
            <ArrowLeft size={14} /> Back to customers
          </Link>
        </div>
        {legacyOpen && (
          <CustomerProfileDialog
            customerId={id}
            onClose={() => setLegacyOpen(false)}
          />
        )}
      </DashboardLayout>
    );
  }

  // ── Loading / error states ──────────────────────────────────────────────────
  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[40vh]">
          <span className="text-slate-500 text-sm">{t("loading", { ns: "common" })}</span>
        </div>
      </DashboardLayout>
    );
  }

  if (error || !data) {
    return (
      <DashboardLayout>
        <div className="space-y-4">
          <Link href="/admin/customers" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
            <ArrowLeft size={14} /> Back to customers
          </Link>
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error?.message ?? "Customer not found."}
          </div>
        </div>
      </DashboardLayout>
    );
  }

  const { customer, rentals, invoices, interactions, stats } = data;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link href="/admin/customers" className="text-slate-400 hover:text-slate-700">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">{customer.name}</h1>
            {customer.company && (
              <p className="text-sm text-slate-500">{customer.company}</p>
            )}
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <KpiCard
            label={t("customerDetail.totalRentals")}
            value={stats.totalRentals}
            icon={Package}
            colorClass="bg-blue-500"
          />
          <KpiCard
            label={t("customerDetail.totalRevenue")}
            value={Number(stats.totalRevenue) > 0 ? formatCurrency(Number(stats.totalRevenue)) : "$0"}
            icon={DollarSign}
            colorClass="bg-emerald-500"
          />
          <KpiCard
            label={t("customerDetail.avgRentalDays")}
            value={stats.avgRentalDays}
            icon={Calendar}
            colorClass="bg-violet-500"
          />
          <KpiCard
            label={t("customerDetail.outstandingBalance")}
            value={Number(stats.outstandingBalance) > 0 ? formatCurrency(Number(stats.outstandingBalance)) : "$0"}
            icon={TrendingUp}
            colorClass={Number(stats.outstandingBalance) > 0 ? "bg-rose-500" : "bg-slate-400"}
          />
        </div>

        {/* Last interaction */}
        {stats.lastInteractionAt && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Clock size={14} />
            <span>Last interaction: {fmtDate(stats.lastInteractionAt)}</span>
          </div>
        )}

        {/* Tabs */}
        <Tabs.Root defaultValue="overview" className="space-y-4">
          <Tabs.List className="flex gap-1 border-b border-slate-200">
            {(["overview", "rentals", "invoices", "interactions"] as const).map((tab) => (
              <Tabs.Trigger
                key={tab}
                value={tab}
                className="px-4 py-2 text-sm font-medium text-slate-500 border-b-2 border-transparent data-[state=active]:border-[var(--primary)] data-[state=active]:text-slate-900 hover:text-slate-700 capitalize transition-colors"
              >
                {tab === "overview" ? "Overview" : tab === "rentals" ? `Rentals (${rentals.length})` : tab === "invoices" ? `Invoices (${invoices.length})` : `Interactions (${interactions.length})`}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          {/* Overview tab */}
          <Tabs.Content value="overview" className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm space-y-3">
              <h2 className="font-semibold text-slate-800 flex items-center gap-2">
                <User size={16} /> Contact Information
              </h2>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
                {customer.email && (
                  <>
                    <dt className="text-slate-500">{t("customerDetail.email")}</dt>
                    <dd className="text-slate-900">{customer.email}</dd>
                  </>
                )}
                {customer.phone && (
                  <>
                    <dt className="text-slate-500">{t("customerDetail.phone")}</dt>
                    <dd className="text-slate-900">{customer.phone}</dd>
                  </>
                )}
                {customer.address && (
                  <>
                    <dt className="text-slate-500">{t("customerDetail.address")}</dt>
                    <dd className="text-slate-900">
                      {[customer.address, customer.city, customer.province, customer.postalCode].filter(Boolean).join(", ")}
                    </dd>
                  </>
                )}
                {customer.notes && (
                  <>
                    <dt className="text-slate-500">{t("customerDetail.notes")}</dt>
                    <dd className="text-slate-900 whitespace-pre-line">{customer.notes}</dd>
                  </>
                )}
              </dl>
            </div>

            {/* Money we hold that is theirs — shown next to their contact
                details because it is a fact about the customer, not about any
                one order. */}
            <CustomerCreditPanel customerId={customer.id} />

            {/* Recent activity summary */}
            {interactions.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm space-y-3">
                <h2 className="font-semibold text-slate-800 flex items-center gap-2">
                  <MessageSquare size={16} /> Recent Interactions
                </h2>
                <ul className="space-y-2">
                  {interactions.slice(0, 3).map((interaction) => (
                    <li key={interaction.id} className="text-sm text-slate-700 flex items-start gap-2">
                      <span className="text-slate-400 text-xs mt-0.5 shrink-0">{fmtDate(interaction.createdAt)}</span>
                      <span>
                        <span className="font-medium">{translateDynamic(t, `customers.profile.interactionType.${interaction.type}`, { defaultValue: interaction.type })}</span>
                        {" — "}
                        <span className="text-slate-600">{interaction.summary}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Tabs.Content>

          {/* Rentals tab */}
          <Tabs.Content value="rentals">
            {rentals.length === 0 ? (
              <p className="text-sm text-slate-400 py-6 text-center">{t("customerDetail.noRentals")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-500 text-xs uppercase tracking-wide">
                      <th className="pb-2 pr-4 font-medium">{t("customerDetail.rentalNumber")}</th>
                      <th className="pb-2 pr-4 font-medium">{t("customerDetail.fleet")}</th>
                      <th className="pb-2 pr-4 font-medium">{t("customerDetail.status")}</th>
                      <th className="pb-2 pr-4 font-medium">{t("customerDetail.dates")}</th>
                      <th className="pb-2 font-medium text-right">{t("customerDetail.amount")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rentals.map((rental) => (
                      <tr key={rental.id} className="hover:bg-slate-50">
                        <td className="py-2 pr-4">
                          <Link
                            href={`/admin/rental-management`}
                            className="font-medium text-[var(--primary)] hover:underline"
                          >
                            {rental.rentalNumber ?? `#${rental.id}`}
                          </Link>
                        </td>
                        <td className="py-2 pr-4 text-slate-700">
                          {rental.fleetBrand && rental.fleetModel
                            ? `${rental.fleetBrand} ${rental.fleetModel}`
                            : "-"}
                        </td>
                        <td className="py-2 pr-4">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${rentalStatusColors[rental.status] ?? "bg-slate-100 text-slate-600"}`}>
                            {t(`status.${rental.status}`, { ns: "common", defaultValue: rental.status })}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-slate-500">
                          {fmtDate(rental.startDate)} - {fmtDate(rental.endDate)}
                        </td>
                        <td className="py-2 text-right text-slate-700 font-medium">
                          {rental.totalAmount ? formatCurrency(Number(rental.totalAmount)) : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Tabs.Content>

          {/* Invoices tab */}
          <Tabs.Content value="invoices">
            {invoices.length === 0 ? (
              <p className="text-sm text-slate-400 py-6 text-center">{t("customerDetail.noInvoices")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-500 text-xs uppercase tracking-wide">
                      <th className="pb-2 pr-4 font-medium">{t("customerDetail.invoiceNumber")}</th>
                      <th className="pb-2 pr-4 font-medium">{t("customerDetail.status")}</th>
                      <th className="pb-2 pr-4 font-medium">{t("customerDetail.issued")}</th>
                      <th className="pb-2 pr-4 font-medium">{t("customerDetail.due")}</th>
                      <th className="pb-2 pr-4 font-medium text-right">{t("customerDetail.total")}</th>
                      <th className="pb-2 font-medium text-right">{t("customerDetail.balanceDue")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {invoices.map((invoice) => (
                      <tr key={invoice.id} className="hover:bg-slate-50">
                        <td className="py-2 pr-4 font-medium text-slate-800 flex items-center gap-1">
                          <FileText size={13} className="text-slate-400" />
                          {invoice.invoiceNumber}
                        </td>
                        <td className="py-2 pr-4">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${rentalStatusColors[invoice.status] ?? "bg-slate-100 text-slate-600"}`}>
                            {translateDynamic(t, `invoices.status${invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}`, { defaultValue: invoice.status })}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-slate-500">{fmtDate(invoice.issueDate)}</td>
                        <td className="py-2 pr-4 text-slate-500">{fmtDate(invoice.dueDate)}</td>
                        <td className="py-2 pr-4 text-right text-slate-700">
                          {formatCurrency(Number(invoice.totalAmount))}
                        </td>
                        <td className="py-2 text-right font-medium">
                          <span className={Number(invoice.balanceDue) > 0 ? "text-rose-600" : "text-emerald-600"}>
                            {formatCurrency(Number(invoice.balanceDue))}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Tabs.Content>

          {/* Interactions tab */}
          <Tabs.Content value="interactions">
            {interactions.length === 0 ? (
              <p className="text-sm text-slate-400 py-6 text-center">{t("customerDetail.noInteractions")}</p>
            ) : (
              <ol className="relative border-l border-slate-200 ml-3 space-y-6">
                {interactions.map((interaction) => (
                  <li key={interaction.id} className="ml-6">
                    <span className="absolute -left-2 flex h-4 w-4 items-center justify-center rounded-full bg-slate-200 ring-4 ring-white" />
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
                        {translateDynamic(t, `customers.profile.interactionType.${interaction.type}`, { defaultValue: interaction.type })}
                      </span>
                      <span className="text-xs text-slate-400">{fmtDate(interaction.createdAt)}</span>
                      {interaction.createdByName && (
                        <span className="text-xs text-slate-400">by {interaction.createdByName}</span>
                      )}
                    </div>
                    <p className="text-sm text-slate-700 whitespace-pre-line">{interaction.summary}</p>
                  </li>
                ))}
              </ol>
            )}
          </Tabs.Content>
        </Tabs.Root>
      </div>
    </DashboardLayout>
  );
}
