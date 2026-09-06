import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { ArrowUpRight, CheckCircle2, RefreshCw, Clock3 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import QueryState from "./QueryState";
import OperationsSuggestions from "./OperationsSuggestions";

const destinations = {
  work_order: "/admin/work-orders", draft_invoice: "/admin/invoices",
  damage_claim: "/admin/damage-claims", dispatch_order: "/admin/dispatch",
  extension_request: "/admin/extension-requests", held_deposit: "/admin/rental-management",
  unbilled_credit_charges: "/admin/invoices", overdue_invoice: "/admin/collections",
} as const;

export default function OperationsDesk({ empty = false }: { empty?: boolean }) {
  const { t } = useTranslation("dashboard");
  const queue = trpc.reports.internalWorkQueue.useQuery(undefined, { staleTime: 30_000, refetchInterval: 60_000, retry: false });
  const [selected, setSelected] = useState<string | null>(null);
  const buckets = [...(queue.data?.buckets ?? [])].filter(b => b.count > 0)
    .sort((a, b) => b.overdueCount - a.overdueCount || b.oldestAgeDays - a.oldestAgeDays);
  const active = buckets.find(b => b.kind === selected) ?? buckets[0];
  return <section className="operations-desk" aria-labelledby="desk-title">
    <div className="desk-intro">
      <div><p className="desk-eyebrow">{t("desk.eyebrow")}</p><h1 id="desk-title">{t("desk.title")}</h1>
      <p className="desk-description">{t("desk.description")}</p></div>
      <div className="desk-date" aria-hidden="true"><span>OPEN</span><strong>RENTAL</strong><span>OPERATIONS / 01</span></div>
    </div>
    {empty && <div className="desk-onboarding"><div><h2>{t("desk.setupTitle")}</h2><p>{t("desk.setupDescription")}</p></div>
      <ol>{([['/admin/system-settings', 'setupCompany'], ['/admin/rental-fleet', 'setupFleet'], ['/admin/customers', 'setupCustomers'], ['/admin/rental-management', 'setupOrder']] as const).map(([href, key], index) =>
        <li key={key}><Link href={href}><span>{index + 1}</span>{t(`desk.${key}`)}<ArrowUpRight size={16} /></Link></li>)}</ol></div>}
    {queue.data && !queue.isError && <OperationsSuggestions queue={queue.data} />}
    <div className="desk-queue">
      <div className="desk-queue-heading"><h2><Clock3 size={18} />{t("desk.queue")}</h2>
        <button className="desk-refresh" onClick={() => void queue.refetch()} disabled={queue.isFetching} aria-label={t("desk.refresh")}>
          <RefreshCw size={16} className={queue.isFetching ? "animate-spin" : ""} />{t("desk.refresh")}</button></div>
      {queue.isPending || queue.isError ? <QueryState loading={queue.isPending} onRetry={() => void queue.refetch()} /> : !active ?
        <div className="desk-clear"><CheckCircle2 size={24} /><div><strong>{t("desk.allClear")}</strong><p>{t("desk.allClearDetail")}</p></div></div> : <>
        <div className="desk-buckets" aria-label={t("desk.queue")}>
          {buckets.map(bucket => <button key={bucket.kind} aria-pressed={bucket.kind === active.kind} onClick={() => setSelected(bucket.kind)} className="desk-bucket">
            <span>{t(`desk.kinds.${bucket.kind}`)}</span><strong>{bucket.count}</strong>
            <small className={bucket.overdueCount ? "desk-overdue" : ""}>{t("desk.overdue", { count: bucket.overdueCount })}</small>
          </button>)}
        </div>
        <div className="desk-items">{active.items.slice(0, 4).map(item => <Link key={item.id} href={active.kind === "draft_invoice" || active.kind === "overdue_invoice" ? `/admin/invoices?invoiceId=${item.id}` : active.kind === "held_deposit" ? `/admin/rental-management?rentalId=${item.id}` : destinations[active.kind]} className="desk-item">
          <span className={`desk-dot ${item.overdue ? "is-overdue" : ""}`} /><div><strong>{item.ref}</strong><p>{item.detail || t(`desk.kinds.${active.kind}`)}</p></div>
          <span className="desk-age">{t("desk.age", { count: item.ageDays })}</span><ArrowUpRight size={17} />
        </Link>)}</div>
        <Link href={destinations[active.kind]} className="desk-all">{t("desk.total", { count: active.count })}<span>{t("desk.open")} <ArrowUpRight size={16} /></span></Link>
      </>}
    </div>
  </section>;
}
