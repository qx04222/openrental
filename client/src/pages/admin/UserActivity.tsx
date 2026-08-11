import { useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import SettingsShell from "@/components/SettingsShell";
import {
  Monitor, Smartphone, Tablet, Clock, Users, LogIn, BarChart3,
  Activity, Globe, Shield, TrendingUp,
} from "lucide-react";

function formatDuration(seconds: number | null): string {
  if (!seconds) return "-";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

function formatTime(date: string | Date | null): string {
  if (!date) return "-";
  return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(date: string | Date | null): string {
  if (!date) return "-";
  return new Date(date).toLocaleDateString();
}

function DeviceIcon({ type, size = 16 }: { type: string | null; size?: number }) {
  const cls = "text-[var(--muted-foreground)]";
  if (type === "mobile") return <Smartphone size={size} className={cls} />;
  if (type === "tablet") return <Tablet size={size} className={cls} />;
  return <Monitor size={size} className={cls} />;
}

function getInitials(name: string | null | undefined): string {
  if (!name) return "?";
  return name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
}

export default function UserActivity() {
  const { t } = useTranslation(["admin", "common"]);
  const [tab, setTab] = useState<"sessions" | "analytics">("sessions");
  const [filterUserId, setFilterUserId] = useState<number | undefined>();
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const { data: userList } = trpc.loginSessions.userList.useQuery();

  const { data: sessionsData, isLoading: loadingSessions } = trpc.loginSessions.list.useQuery({
    userId: filterUserId,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    limit: pageSize,
    offset: page * pageSize,
  }, { enabled: tab === "sessions" });

  const [analyticsDays, setAnalyticsDays] = useState(30);
  const { data: analytics, isLoading: loadingAnalytics } = trpc.loginSessions.analytics.useQuery(
    { days: analyticsDays },
    { enabled: tab === "analytics" },
  );

  // Quick stats from sessions data
  const onlineCount = sessionsData?.sessions.filter(s => !s.logoutAt).length ?? 0;

  return (
    <SettingsShell>
      <div className="space-y-8">
        {/* Page Header */}
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight text-[var(--on-surface)] font-headline">
            {t("admin:userActivity.title")}
          </h1>
          <p className="text-[var(--muted-foreground)] mt-1">
            {t("admin:userActivity.subtitle", { defaultValue: "Monitor login activity, session durations, and user engagement" })}
          </p>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-[var(--outline-variant)]/20">
          {[
            { key: "sessions" as const, label: t("admin:userActivity.loginRecords"), icon: Shield },
            { key: "analytics" as const, label: t("admin:userActivity.analyticsPanel"), icon: BarChart3 },
          ].map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 -mb-px transition ${
                tab === key
                  ? "border-[var(--primary)] text-[var(--primary)]"
                  : "border-transparent text-[var(--muted-foreground)] hover:text-[var(--on-surface)]"
              }`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>

        {/* ═══════════════ Tab 1: Login Records ═══════════════ */}
        {tab === "sessions" && (
          <div className="space-y-6">
            {/* Quick stats row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MiniStat
                icon={LogIn}
                label={t("admin:userActivity.totalRecords", { defaultValue: "Total Records" })}
                value={sessionsData?.total ?? 0}
                color="text-blue-500"
                bg="bg-blue-50"
              />
              <MiniStat
                icon={Activity}
                label={t("common:online", { defaultValue: "Online Now" })}
                value={onlineCount}
                color="text-emerald-500"
                bg="bg-emerald-50"
              />
              <MiniStat
                icon={Users}
                label={t("admin:userActivity.uniqueUsers", { defaultValue: "Unique Users" })}
                value={userList?.length ?? 0}
                color="text-purple-500"
                bg="bg-purple-50"
              />
              <MiniStat
                icon={Globe}
                label={t("admin:userActivity.devices", { defaultValue: "Device Types" })}
                value={new Set(sessionsData?.sessions.map(s => s.deviceType).filter(Boolean)).size || "-"}
                color="text-amber-500"
                bg="bg-amber-50"
              />
            </div>

            {/* Filters */}
            <div className="flex flex-wrap gap-3 items-center">
              <select
                value={filterUserId ?? ""}
                onChange={(e) => { setFilterUserId(e.target.value ? Number(e.target.value) : undefined); setPage(0); }}
                className="bg-[var(--surface-container-low)] border-none rounded-xl px-4 py-2.5 text-sm text-[var(--on-surface)] focus:ring-1 focus:ring-[var(--primary)]/20"
              >
                <option value="">{t("admin:userActivity.allUsers")}</option>
                {userList?.map((u) => (
                  <option key={u.id} value={u.id}>{u.name || u.username}</option>
                ))}
              </select>
              <input
                type="date"
                value={startDate}
                onChange={(e) => { setStartDate(e.target.value); setPage(0); }}
                className="bg-[var(--surface-container-low)] border-none rounded-xl px-4 py-2.5 text-sm text-[var(--on-surface)] focus:ring-1 focus:ring-[var(--primary)]/20"
              />
              <input
                type="date"
                value={endDate}
                onChange={(e) => { setEndDate(e.target.value); setPage(0); }}
                className="bg-[var(--surface-container-low)] border-none rounded-xl px-4 py-2.5 text-sm text-[var(--on-surface)] focus:ring-1 focus:ring-[var(--primary)]/20"
              />
              {(filterUserId || startDate || endDate) && (
                <button
                  onClick={() => { setFilterUserId(undefined); setStartDate(""); setEndDate(""); setPage(0); }}
                  className="text-xs text-[var(--primary)] hover:underline font-medium"
                >
                  {t("common:clearAll", { defaultValue: "Clear filters" })}
                </button>
              )}
            </div>

            {/* Session Cards / Table */}
            <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm overflow-hidden">
              <div className="px-6 lg:px-8 py-5 border-b border-[var(--outline-variant)]/10">
                <h3 className="text-lg font-bold font-headline text-[var(--on-surface)]">
                  {t("admin:userActivity.loginRecords")}
                </h3>
              </div>

              {loadingSessions ? (
                <div className="px-8 py-16 text-center text-[var(--muted-foreground)]">{t("common:loading")}</div>
              ) : !sessionsData?.sessions.length ? (
                <div className="px-8 py-16 text-center text-[var(--muted-foreground)]">{t("common:noData")}</div>
              ) : (
                <div className="divide-y divide-[var(--outline-variant)]/5">
                  {sessionsData.sessions.map((s) => {
                    const isOnline = !s.logoutAt;
                    const displayName = s.userName || s.userUsername || "-";
                    return (
                      <div key={s.id} className="px-6 lg:px-8 py-4 flex items-center gap-4 hover:bg-[var(--surface-container-low)]/30 transition-colors">
                        {/* Avatar */}
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${
                          isOnline ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
                        }`}>
                          {getInitials(displayName)}
                        </div>

                        {/* User + Time */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-[var(--on-surface)] truncate">{displayName}</span>
                            {isOnline && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold uppercase">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                {t("common:online")}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-xs text-[var(--muted-foreground)]">
                            <span>{formatDate(s.loginAt)}</span>
                            <span>{formatTime(s.loginAt)} → {s.logoutAt ? formatTime(s.logoutAt) : "..."}</span>
                          </div>
                        </div>

                        {/* Duration */}
                        <div className="text-right hidden sm:block">
                          <div className="text-sm font-bold text-[var(--on-surface)]">
                            {formatDuration(s.durationSeconds)}
                          </div>
                          <div className="text-[10px] text-[var(--muted-foreground)] uppercase tracking-wider">
                            {t("admin:userActivity.duration")}
                          </div>
                        </div>

                        {/* Device + Browser */}
                        <div className="hidden md:flex items-center gap-3 text-xs text-[var(--muted-foreground)]">
                          <div className="flex items-center gap-1.5">
                            <DeviceIcon type={s.deviceType} size={14} />
                            <span>{s.browser || "-"}</span>
                          </div>
                          <span className="text-slate-300">|</span>
                          <span>{s.os || "-"}</span>
                        </div>

                        {/* IP */}
                        <div className="hidden lg:block text-xs font-mono text-[var(--muted-foreground)]">
                          {s.ipAddress || "-"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Pagination */}
              {sessionsData && sessionsData.total > pageSize && (
                <div className="px-6 lg:px-8 py-4 bg-[var(--surface-container-low)]/20 flex items-center justify-between text-xs text-[var(--muted-foreground)]">
                  <span>
                    {page * pageSize + 1}-{Math.min((page + 1) * pageSize, sessionsData.total)} / {sessionsData.total}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={page === 0}
                      className="p-2 border border-[var(--outline-variant)]/10 rounded-lg hover:bg-[var(--surface-container-high)] transition-colors disabled:opacity-40"
                    >
                      {t("common:previous")}
                    </button>
                    <button
                      onClick={() => setPage((p) => p + 1)}
                      disabled={(page + 1) * pageSize >= sessionsData.total}
                      className="p-2 border border-[var(--outline-variant)]/10 rounded-lg hover:bg-[var(--surface-container-high)] transition-colors disabled:opacity-40"
                    >
                      {t("common:next")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══════════════ Tab 2: Analytics ═══════════════ */}
        {tab === "analytics" && (
          <div className="space-y-6">
            {/* Period selector */}
            <div className="flex gap-2">
              {[7, 14, 30, 90].map((d) => (
                <button
                  key={d}
                  onClick={() => setAnalyticsDays(d)}
                  className={`px-4 py-2 text-sm font-medium rounded-lg border transition ${
                    analyticsDays === d
                      ? "bg-[var(--primary)]/10 text-[var(--primary)] font-bold border-[var(--primary)]/20"
                      : "border-slate-200 text-[var(--muted-foreground)] hover:bg-slate-50"
                  }`}
                >
                  {d}{t("admin:userActivity.days")}
                </button>
              ))}
            </div>

            {loadingAnalytics ? (
              <div className="text-center py-16 text-[var(--muted-foreground)]">{t("common:loading")}</div>
            ) : analytics && (
              <>
                {/* Bento Stat Grid */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  {/* Hero card — Total Logins */}
                  <div className="col-span-1 md:col-span-2 bg-[var(--surface-container-lowest)] p-6 rounded-xl shadow-sm flex flex-col justify-between h-44 relative overflow-hidden">
                    <div className="relative z-10">
                      <p className="text-xs font-bold text-[var(--primary)] uppercase tracking-widest mb-1">
                        {t("admin:userActivity.totalLogins")}
                      </p>
                      <h3 className="text-5xl font-extrabold text-[var(--on-surface)] font-headline">
                        {analytics.totalLogins}
                      </h3>
                    </div>
                    <div className="relative z-10 flex items-center gap-2 text-[var(--muted-foreground)] text-sm">
                      <TrendingUp size={14} />
                      <span>{t("admin:userActivity.lastNDays", { days: analyticsDays })}</span>
                    </div>
                    <div className="absolute -right-6 -bottom-6 opacity-[0.04] text-[var(--primary)]">
                      <LogIn size={160} strokeWidth={1} />
                    </div>
                  </div>

                  <div className="bg-[var(--surface-container-low)] p-6 rounded-xl flex flex-col justify-between">
                    <div>
                      <p className="text-xs font-bold text-[var(--muted-foreground)] uppercase tracking-widest mb-1">
                        {t("admin:userActivity.avgSession")}
                      </p>
                      <h3 className="text-3xl font-extrabold text-[var(--on-surface)] font-headline">
                        {analytics.avgSessionMinutes}m
                      </h3>
                    </div>
                    <div className="flex items-center gap-1.5 text-[var(--muted-foreground)] text-sm">
                      <Clock size={14} />
                      <span>{t("admin:userActivity.perSession", { defaultValue: "per session" })}</span>
                    </div>
                  </div>

                  <div className="bg-[var(--surface-container-low)] p-6 rounded-xl flex flex-col justify-between">
                    <div>
                      <p className="text-xs font-bold text-[var(--muted-foreground)] uppercase tracking-widest mb-1">
                        {t("admin:userActivity.activeUsers")}
                      </p>
                      <h3 className="text-3xl font-extrabold text-[var(--on-surface)] font-headline">
                        {analytics.activeUsers}
                      </h3>
                    </div>
                    <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                      <div
                        className="bg-emerald-500 h-full rounded-full"
                        style={{ width: `${Math.min(100, (analytics.activeUsers / Math.max(1, userList?.length ?? 1)) * 100)}%` }}
                      />
                    </div>
                  </div>
                </div>

                {/* Total Hours card */}
                <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-6 flex items-center gap-6">
                  <div className="p-3 bg-amber-50 rounded-xl">
                    <BarChart3 size={24} className="text-amber-500" />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-[var(--muted-foreground)] uppercase tracking-widest">
                      {t("admin:userActivity.totalHours")}
                    </p>
                    <p className="text-2xl font-extrabold text-[var(--on-surface)] font-headline">
                      {analytics.totalActiveHours}h
                    </p>
                  </div>
                </div>

                {/* Daily Logins Chart */}
                <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm overflow-hidden">
                  <div className="px-6 py-5 border-b border-[var(--outline-variant)]/10">
                    <h3 className="text-lg font-bold font-headline text-[var(--on-surface)]">
                      {t("admin:userActivity.dailyLogins")}
                    </h3>
                  </div>
                  <div className="p-6">
                    {analytics.loginsByDay.length === 0 ? (
                      <div className="text-center py-12 text-[var(--muted-foreground)]">{t("common:noData")}</div>
                    ) : (
                      <div className="flex items-end gap-1.5 h-48">
                        {(() => {
                          const maxCount = Math.max(...analytics.loginsByDay.map((d) => d.count), 1);
                          return analytics.loginsByDay.map((d) => (
                            <div key={d.date} className="flex-1 flex flex-col items-center gap-1.5 min-w-0 group">
                              <span className="text-[10px] font-bold text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 transition-opacity">
                                {d.count}
                              </span>
                              <div
                                className="w-full bg-[var(--primary)]/80 group-hover:bg-[var(--primary)] rounded-t-sm min-h-[3px] transition-colors"
                                style={{ height: `${Math.max(3, (d.count / maxCount) * 160)}px` }}
                              />
                              <span className="text-[9px] text-[var(--muted-foreground)] truncate w-full text-center">
                                {d.date?.slice(5)}
                              </span>
                            </div>
                          ));
                        })()}
                      </div>
                    )}
                  </div>
                </div>

                {/* Top Users */}
                <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm overflow-hidden">
                  <div className="px-6 py-5 border-b border-[var(--outline-variant)]/10">
                    <h3 className="text-lg font-bold font-headline text-[var(--on-surface)]">
                      {t("admin:userActivity.topUsers")}
                    </h3>
                  </div>
                  <div className="divide-y divide-[var(--outline-variant)]/5">
                    {analytics.topUsers.length === 0 ? (
                      <div className="px-6 py-12 text-center text-[var(--muted-foreground)]">{t("common:noData")}</div>
                    ) : analytics.topUsers.map((u, i) => {
                      const maxLogins = Math.max(...analytics.topUsers.map(x => x.loginCount), 1);
                      return (
                        <div key={u.userId} className="px-6 py-4 flex items-center gap-4 hover:bg-[var(--surface-container-low)]/30 transition-colors">
                          <span className={`w-8 h-8 flex items-center justify-center rounded-full text-xs font-bold ${
                            i === 0 ? "bg-amber-100 text-amber-700" :
                            i === 1 ? "bg-slate-200 text-slate-600" :
                            i === 2 ? "bg-orange-100 text-orange-700" :
                            "bg-slate-100 text-slate-500"
                          }`}>
                            {i + 1}
                          </span>
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-bold text-[var(--on-surface)]">{u.userName || u.userUsername || "-"}</span>
                            <div className="w-full bg-slate-100 h-1 rounded-full mt-1.5 overflow-hidden">
                              <div
                                className="bg-[var(--primary)]/60 h-full rounded-full"
                                style={{ width: `${(u.loginCount / maxLogins) * 100}%` }}
                              />
                            </div>
                          </div>
                          <div className="text-right">
                            <span className="text-sm font-bold text-[var(--on-surface)]">{u.loginCount}</span>
                            <span className="text-xs text-[var(--muted-foreground)] ml-1">{t("admin:userActivity.logins")}</span>
                          </div>
                          <div className="text-right hidden sm:block">
                            <span className="text-sm font-bold text-[var(--on-surface)]">{u.totalHours}h</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </SettingsShell>
  );
}

function MiniStat({ icon: Icon, label, value, color, bg }: {
  icon: React.ElementType; label: string; value: string | number; color: string; bg: string;
}) {
  return (
    <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-5 flex items-center gap-4">
      <div className={`${bg} p-2.5 rounded-xl`}>
        <Icon size={18} className={color} />
      </div>
      <div>
        <div className="text-2xl font-extrabold text-[var(--on-surface)] font-headline">{value}</div>
        <div className="text-[10px] text-[var(--muted-foreground)] uppercase tracking-wider font-medium">{label}</div>
      </div>
    </div>
  );
}
