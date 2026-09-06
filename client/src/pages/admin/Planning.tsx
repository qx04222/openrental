import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, RefreshCw, Search, BookmarkPlus, Trash2, CalendarDays, X } from "lucide-react";
import { toast } from "sonner";
import DashboardLayout from "@/components/DashboardLayout";
import QueryState from "@/components/QueryState";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/useAuth";
import { formatCalendarDateISO } from "@/lib/dateUtils";
import { isCalendarDate, shiftPlanningDate } from "@shared/planning";
import { decodePlanningViews, planningStorageKey, readPlanningFilters, type PlanningFilters, type PlanningView } from "@/lib/planningViews";

export default function Planning() {
  const { t } = useTranslation("common");
  const { user } = useAuth();
  const [start, setStart] = useState(() => { const value = new URLSearchParams(location.search).get("start"); return value && isCalendarDate(value) ? value : formatCalendarDateISO(new Date()); });
  const [filters, setFilters] = useState<PlanningFilters>(() => { const p = Object.fromEntries(new URLSearchParams(location.search)); return readPlanningFilters({ ...p, days: Number(p.days) }); });
  const [dayIndex, setDayIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [views, setViews] = useState<PlanningView[]>([]);
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => { if (selectedId !== null) detailRef.current?.scrollIntoView({ block: "nearest" }); }, [selectedId]);
  const [viewName, setViewName] = useState("");
  const [viewId, setViewId] = useState("");
  const key = user?.userId ? planningStorageKey(String(user.userId)) : null;
  const query = trpc.planning.timeline.useQuery({ start, days: filters.days }, { staleTime: 30_000, refetchInterval: 60_000 });
  useEffect(() => { try { setViews(key ? decodePlanningViews(localStorage.getItem(key)) : []); } catch { setViews([]); } setViewId(""); }, [key]);
  useEffect(() => {
    const p = new URLSearchParams({ start, days: String(filters.days) });
    for (const k of ["search", "category", "location", "status"] as const) if (filters[k] && filters[k] !== "all") p.set(k, filters[k]);
    history.replaceState(history.state, "", `${location.pathname}?${p}`);
  }, [start, filters]);
  const update = (next: Partial<PlanningFilters>) => { setFilters(f => ({ ...f, ...next })); setViewId(""); if (next.days) setDayIndex(0); };
  const storeViews = (next: PlanningView[]) => {
    if (!key) return false;
    try { localStorage.setItem(key, JSON.stringify(next)); setViews(next); return true; } catch { toast.error(t("planning.storageError")); return false; }
  };
  const saveView = () => {
    const name = viewName.trim(); if (!name || !key) return;
    const existing = views.find(v => v.name === name);
    if (!existing && views.length >= 8) { toast.error(t("planning.viewLimit")); return; }
    const view = { id: existing?.id ?? crypto.randomUUID(), name, filters };
    if (storeViews([...views.filter(v => v.id !== view.id), view])) setViewName("");
  };
  const data = query.data;
  const focus = Math.min(dayIndex, filters.days - 1);
  const baseRows = useMemo(() => (data?.rows ?? []).filter(row => (!filters.search || `${row.name} ${row.assetNumber}`.toLowerCase().includes(filters.search.toLowerCase())) && (!filters.category || row.category === filters.category) && (!filters.location || row.location === filters.location)), [data, filters.search, filters.category, filters.location]);
  const rows = baseRows.filter(row => filters.status === "all" || (filters.status === "available" ? row.days[focus]?.state === "available" : row.days[focus]?.overdue || row.days[focus]?.conflict || !["available", "reserved"].includes(row.days[focus]?.state)));
  const selected = data?.rows.find(row => row.id === selectedId);
  const detail = selected?.days[focus];
  const categories = [...new Set(data?.rows.map(row => row.category).filter(Boolean))].sort();
  const locations = [...new Set(data?.rows.map(row => row.location).filter(Boolean))].sort();
  const move = (days: number) => { setStart(value => shiftPlanningDate(value, days)); setDayIndex(0); };
  return <DashboardLayout><div className="planning-page">
    <header className="planning-header"><div><p className="planning-eyebrow">{t("planning.eyebrow")}</p><h1>{t("planning.title")}</h1><p>{t("planning.subtitle")}</p></div><button className="btn-secondary" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw size={16} />{t("ops.refresh")}</button></header>
    <section className="planning-controls" aria-label={t("planning.filters")}>
      <div className="planning-datebar"><button className="btn-secondary" aria-label={t("planning.previous")} onClick={() => move(-filters.days)}><ArrowLeft size={18} /></button><label>{t("planning.start")}<input type="date" value={start} onChange={e => { if (isCalendarDate(e.target.value)) { setStart(e.target.value); setDayIndex(0); } }} /></label><button className="btn-secondary" aria-label={t("planning.next")} onClick={() => move(filters.days)}><ArrowRight size={18} /></button><button className="btn-secondary" onClick={() => { setStart(data?.today ?? formatCalendarDateISO(new Date())); setDayIndex(0); }}>{t("planning.today")}</button><label>{t("planning.window")}<select aria-label={t("planning.window")} value={filters.days} onChange={e => update({ days: Number(e.target.value) as 7 | 14 | 28 })}>{[7, 14, 28].map(n => <option key={n} value={n}>{t("planning.days", { count: n })}</option>)}</select></label></div>
      <div className="planning-filterbar"><label className="planning-search"><span><Search size={15} />{t("planning.search")}</span><input value={filters.search} onChange={e => update({ search: e.target.value })} maxLength={100} /></label><label>{t("planning.category")}<select aria-label={t("planning.category")} value={filters.category} onChange={e => update({ category: e.target.value })}><option value="">{t("planning.all")}</option>{categories.map(c => <option key={c}>{c}</option>)}</select></label><label>{t("planning.location")}<select aria-label={t("planning.location")} value={filters.location} onChange={e => update({ location: e.target.value })}><option value="">{t("planning.all")}</option>{locations.map(c => <option key={c}>{c}</option>)}</select></label><label>{t("planning.show")}<select aria-label={t("planning.show")} value={filters.status} onChange={e => update({ status: e.target.value as PlanningFilters["status"] })}>{(["all", "available", "attention"] as const).map(v => <option key={v} value={v}>{t(`planning.${v}`)}</option>)}</select></label></div>
      <div className="planning-views"><label>{t("planning.saved")}<select aria-label={t("planning.saved")} value={viewId} onChange={e => { const v = views.find(v => v.id === e.target.value); if (v) { setFilters(v.filters); setViewId(v.id); setDayIndex(0); } }}><option value="">{t("planning.chooseView")}</option>{views.map(v => <option value={v.id} key={v.id}>{v.name}</option>)}</select></label>{viewId && <button className="btn-secondary" aria-label={t("planning.deleteView")} onClick={() => { if (storeViews(views.filter(v => v.id !== viewId))) setViewId(""); }}><Trash2 size={16} /></button>}<label>{t("planning.nameView")}<input value={viewName} onChange={e => setViewName(e.target.value)} maxLength={40} /></label><button className="btn-secondary" onClick={saveView} disabled={!key || !viewName.trim()}><BookmarkPlus size={16} />{t("planning.save")}</button><small>{t("planning.localViews")}</small></div>
    </section>
    {query.isPending || query.isError ? <QueryState loading={query.isPending} onRetry={() => void query.refetch()} /> : data && <>
      <div className="planning-summary"><div><strong>{baseRows.length}</strong><span>{t("planning.assets")}</span></div><div><strong>{baseRows.filter(r => r.days[focus].state === "available").length}</strong><span>{t("planning.available")}</span></div><div><strong>{baseRows.filter(r => r.days[focus].conflict || r.days[focus].overdue).length}</strong><span>{t("planning.risk")}</span></div><label><CalendarDays size={16} />{t("planning.focus")}<select aria-label={t("planning.focus")} value={focus} onChange={e => setDayIndex(Number(e.target.value))}>{data.days.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label></div>
      <p className="planning-note">{t("planning.forecast")} · {data.timezone}</p>
      <div className="planning-legend">{(["available", "reserved", "conflict", "maintenance", "work_order", "return", "custody"] as const).map(state => <span key={state}><i className={`planning-state-${state}`} />{t(`planning.state.${state}`)}</span>)}</div>
      {rows.length === 0 ? <div className="query-state">{t("planning.empty")}</div> : <>
        <div className="planning-timeline" role="region" tabIndex={0} aria-label={t("planning.timeline")}><div className="planning-grid" style={{ "--planning-days": filters.days } as CSSProperties}>
          <div className="planning-grid-corner">{t("planning.equipment")}</div>{data.days.map((d, i) => <button key={d} className={`planning-day ${i === focus ? "is-focused" : ""}`} aria-pressed={i === focus} onClick={() => setDayIndex(i)}>{d.slice(5)}{d === data.today && <small>{t("planning.today")}</small>}</button>)}
          {rows.map(row => <div className="planning-grid-row" key={row.id}><button className="planning-asset" onClick={() => setSelectedId(row.id)}><strong>{row.assetNumber}</strong><span>{row.name}</span></button>{row.days.map((day, i) => <button key={day.date} className={`planning-cell planning-state-${day.state} ${day.conflict || day.overdue ? "is-risk" : ""}`} aria-label={`${row.assetNumber}, ${day.date}, ${t(`planning.state.${day.state}`)}${day.overdue ? `, ${t("planning.overdue")}` : ""}`} onClick={() => { setSelectedId(row.id); setDayIndex(i); }}>{day.overdue ? "!" : day.rentals.length || (day.state === "available" ? "·" : "—")}</button>)}</div>)}
        </div></div>
        <div className="planning-mobile-list">{rows.map(row => <button key={row.id} className={`planning-mobile-card planning-state-${row.days[focus].state}`} onClick={() => setSelectedId(row.id)}><strong>{row.assetNumber} · {row.name}</strong><span>{t(`planning.state.${row.days[focus].state}`)}{row.days[focus].overdue && ` · ${t("planning.overdue")}`}</span></button>)}</div>
      </>}
      {selected && detail && <section ref={detailRef} className="planning-detail" aria-label={t("planning.detail")}><div><h2>{selected.assetNumber} · {selected.name}</h2><button className="btn-secondary" aria-label={t("workspace.close")} onClick={() => setSelectedId(null)}><X size={18} /></button></div><p>{detail.date} · {t(`planning.state.${detail.state}`)}{detail.overdue && ` · ${t("planning.overdue")}`}</p>{selected.blockRefs.length > 0 && <p>{t("planning.holds")}: {selected.blockRefs.join(", ")}</p>}{detail.rentals.map(r => <Link key={r.rentalId} href={`/admin/rental-management?rentalId=${r.rentalId}`} className="planning-order"><strong>{r.reference}</strong><span>{r.start} → {r.end.startsWith("2099") ? t("planning.openEnded") : r.end}</span><ArrowRight size={16} /></Link>)}<Link href={`/admin/rental-fleet/${selected.id}/inspections`}>{t("planning.history")}</Link></section>}
    </>}
  </div></DashboardLayout>;
}
