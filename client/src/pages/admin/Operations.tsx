import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { Activity, RefreshCw, ArrowRight } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import QueryState from "@/components/QueryState";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/useAuth";

export default function Operations() {
  const { t, i18n } = useTranslation("common");
  const { user, isLoading } = useAuth();
  const allowed = user?.role === "super_admin";
  const query = trpc.operations.status.useQuery(undefined, { enabled: allowed, refetchInterval: 30_000, staleTime: 10_000 });
  const health = trpc.reports.operationalHealth.useQuery(undefined, { enabled: allowed, refetchInterval: 30_000, staleTime: 10_000 });
  const refresh = () => { void query.refetch(); void health.refetch(); };
  const data = query.data;
  const formatTime = (value: string | null) => value ? new Intl.DateTimeFormat(i18n.language === "zh" ? "zh-CN" : "en-CA", { timeZone: data?.timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)) : t("ops.notYet");
  const count = (status: string) => data?.counts.find(c => c.status === status)?.count ?? 0;
  return <DashboardLayout><div className="planning-page">
    <header className="planning-header"><div><p className="planning-eyebrow">{t("ops.eyebrow")}</p><h1>{t("ops.title")}</h1><p>{t("ops.subtitle")}</p></div><button className="btn-secondary" onClick={refresh} disabled={!allowed || query.isFetching || health.isFetching}><RefreshCw size={16} />{t("ops.refresh")}</button></header>
    {!isLoading && !allowed ? <div className="query-state" role="alert">{t("ops.denied")}</div> : query.isPending || query.isError || health.isPending || health.isError ? <QueryState loading={isLoading || query.isPending || health.isPending} onRetry={refresh} /> : data && <>
      <div className="ops-release"><span><Activity size={18} />{t("ops.connected")}</span><span>v{data.version} · {data.timezone}</span><small>{t("ops.checked", { time: formatTime(data.generatedAt) })}</small></div>
      <div className="ops-metrics"><div><strong>{health.data?.count ?? 0}</strong><span>{t("ops.businessGaps")}</span></div><div><strong>{count("manual_review")}</strong><span>{t("ops.manual")}</span></div><div><strong>{count("failed")}</strong><span>{t("ops.retrying")}</span></div><div><strong>{count("pending") + count("processing")}</strong><span>{t("ops.waiting")}</span></div></div>
      <section className="ops-section"><h2>{t("ops.businessGaps")}</h2><p>{t("ops.gapsHint")}</p>{health.data?.items.length ? <div className="ops-items">{health.data.items.map(item => <Link key={`${item.id}-${item.issue}`} href={`/admin/rental-management?rentalId=${item.id}`} className="planning-order"><strong>{item.orderNo}</strong><span>{t(`ops.issue.${item.issue}`, { defaultValue: item.issue })}</span><ArrowRight size={16} /></Link>)}</div> : <div className="ops-empty">{t("ops.noGaps")}</div>}</section>
      <section className="ops-section"><h2>{t("ops.queue")}</h2><p>{t("ops.queueHint")}</p>{data.effects.length ? <div className="ops-items">{data.effects.map(effect => <Link key={effect.id} href={`/admin/rental-management?rentalId=${effect.rentalId}`} className="ops-effect"><div><strong>{effect.reference}</strong><span>{t(`ops.effect.${effect.effectType}`, { defaultValue: effect.effectType })}</span></div><div><span className={`ops-status ops-status-${effect.status}`}>{t(`ops.status.${effect.status}`, { defaultValue: effect.status })}</span><small>{t("ops.attempts", { count: effect.attempts })} · {formatTime(effect.updatedAt)}</small></div><ArrowRight size={16} /></Link>)}</div> : <div className="ops-empty">{t("ops.noPending")}</div>}</section>
      <section className="ops-section"><h2>{t("ops.jobs")}</h2><p>{t("ops.jobsHint")}</p><div className="ops-job-grid">{data.jobs.map(job => <article key={job.name} className="ops-job"><div><h3>{t(`ops.job.${job.name}`, { defaultValue: job.name })}</h3><span className={`ops-status ops-status-${job.status}`}>{t(`ops.status.${job.status}`)}</span></div><p>{t(`ops.schedule.${job.name}`, { defaultValue: job.schedule })}</p><dl><div><dt>{t("ops.lastStarted")}</dt><dd>{formatTime(job.startedAt)}</dd></div><div><dt>{t("ops.lastClean")}</dt><dd>{formatTime(job.lastSuccessAt)}</dd></div><div><dt>{t("ops.observed")}</dt><dd>{job.runs} / {job.skipped}</dd></div><div><dt>{t("ops.warningsErrors")}</dt><dd>{job.warnings} / {job.errors}</dd></div></dl></article>)}</div>{data.jobs.length === 0 && <div role="alert" className="ops-empty">{t("ops.noJobs")}</div>}</section>
      <p className="planning-note">{t("ops.processSince", { time: formatTime(data.startedAt) })} · {data.revision}</p>
    </>}
  </div></DashboardLayout>;
}
