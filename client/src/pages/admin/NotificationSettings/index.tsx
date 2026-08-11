import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import SettingsShell from "@/components/SettingsShell";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Eye, EyeOff, CheckCircle2, XCircle, RefreshCw, Bell, Mail, Smartphone,
  History, Settings2, Zap, Send, TrendingUp, BarChart3, Gift, AlertTriangle,
} from "lucide-react";
import TemplatesTab from "./TemplatesTab";
import EventsTab from "./EventsTab";
import HistoryTab from "./HistoryTab";
import { serverErrorText } from "@/lib/serverError";

type Tab = "general" | "email" | "sms" | "templates" | "events" | "history";

interface NotificationTemplate {
  id: number;
  name: string;
  channel: string;
  event: string;
  subject: string | null;
  body: string;
  isActive: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}

const emptyTemplate = {
  name: "", channel: "email", event: "", subject: "", body: "", isActive: true,
};

const RENTAL_EVENTS = [
  { value: "rental_pending", label: "notifications.event_rental_pending" },
  { value: "rental_approved", label: "notifications.event_rental_approved" },
  { value: "rental_active", label: "notifications.event_rental_active" },
  { value: "rental_completed", label: "notifications.event_rental_completed" },
  { value: "rental_cancelled", label: "notifications.event_rental_cancelled" },
  { value: "rental_rejected", label: "notifications.event_rental_rejected" },
  { value: "payment_received", label: "notifications.event_payment_received" },
  { value: "dispatch_created", label: "notifications.event_dispatch_created" },
  { value: "inspection_completed", label: "notifications.event_inspection_completed" },
  { value: "contract_generated", label: "notifications.event_contract_generated" },
  { value: "invoice_created", label: "notifications.event_invoice_created" },
  { value: "invoice_overdue", label: "notifications.event_invoice_overdue" },
  { value: "order_confirmation", label: "notifications.event_order_confirmation" },
  { value: "extension_requested", label: "notifications.event_extension_requested" },
  { value: "extension_approved", label: "notifications.event_extension_approved" },
  { value: "extension_rejected", label: "notifications.event_extension_rejected" },
];

// ─── Utility sub-components ─────────────────────────────────────

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${checked ? "bg-[var(--primary)]" : "bg-slate-200"}`}
    >
      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${checked ? "translate-x-5" : "translate-x-0"}`} />
    </button>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number | string; color: string }) {
  const colorMap: Record<string, string> = {
    green: "bg-green-50 text-green-600",
    red: "bg-[var(--primary)]/10 text-[var(--primary)]",
    blue: "bg-blue-50 text-blue-600",
    purple: "bg-purple-50 text-purple-600",
    amber: "bg-amber-50 text-amber-600",
    indigo: "bg-indigo-50 text-indigo-600",
  };
  return (
    <div className="card !p-4 flex items-center gap-3">
      <div className={`p-2 rounded-lg ${colorMap[color] || "bg-slate-50 text-slate-600"}`}>{icon}</div>
      <div>
        <div className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{value}</div>
        <div className="text-xs text-slate-500">{label}</div>
      </div>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────

export default function NotificationSettings() {
  const { t } = useTranslation("admin");
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<Tab>("general");

  // ─── Queries ────────────────────────────────────────────────
  const { data: _allConfig } = trpc.notifications.getAllConfig.useQuery();
  const { data: emailConfig } = trpc.notifications.getConfig.useQuery({ provider: "resend" });
  const { data: smsConfig } = trpc.notifications.getConfig.useQuery({ provider: "telnyx" });
  const { data: globalConfig } = trpc.notifications.getConfig.useQuery({ provider: "global" });
  const { data: templates } = trpc.notifications.getTemplates.useQuery();
  const { data: stats, error: statsError } = trpc.notifications.getStats.useQuery();
  const [historyChannel, setHistoryChannel] = useState<string>("");
  const [historyStatus, setHistoryStatus] = useState<string>("");
  const { data: logs } = trpc.notifications.getLog.useQuery({
    channel: historyChannel || undefined,
    status: historyStatus || undefined,
    limit: 200,
  });

  // ─── Config maps ───────────────────────────────────────────
  const emailCfg = useMemo(() => {
    const map: Record<string, string> = {};
    emailConfig?.forEach((c: { configKey: string; configValue: string }) => { map[c.configKey] = c.configValue; });
    return map;
  }, [emailConfig]);

  const smsCfg = useMemo(() => {
    const map: Record<string, string> = {};
    smsConfig?.forEach((c: { configKey: string; configValue: string }) => { map[c.configKey] = c.configValue; });
    return map;
  }, [smsConfig]);

  const globalCfg = useMemo(() => {
    const map: Record<string, string> = {};
    globalConfig?.forEach((c: { configKey: string; configValue: string }) => { map[c.configKey] = c.configValue; });
    return map;
  }, [globalConfig]);

  // ─── Email state ───────────────────────────────────────────
  const [resendKey, setResendKey] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [bccAdmin, setBccAdmin] = useState("");
  const [emailSignature, setEmailSignature] = useState("");
  const [showKey, setShowKey] = useState(false);

  // ─── SMS state ─────────────────────────────────────────────
  const [telnyxApiKey, setTelnyxApiKey] = useState("");
  const [telnyxFrom, setTelnyxFrom] = useState("");
  const [telnyxProfileId, setTelnyxProfileId] = useState("");
  const [showToken, setShowToken] = useState(false);

  // ─── Global state ─────────────────────────────────────────
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [smsEnabled, setSmsEnabled] = useState(true);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminNotifyEvents, setAdminNotifyEvents] = useState("rental_pending");

  // ─── Template state ────────────────────────────────────────
  const [templateModal, setTemplateModal] = useState(false);
  const [editTemplate, setEditTemplate] = useState<NotificationTemplate | null>(null);
  const [templateForm, setTemplateForm] = useState(emptyTemplate);
  const [previewMode, setPreviewMode] = useState(false);

  // ─── Test state ────────────────────────────────────────────
  const [testEmailTo, setTestEmailTo] = useState("");
  const [testSmsTo, setTestSmsTo] = useState("");

  // ─── Connection status ─────────────────────────────────────
  const [emailConnStatus, setEmailConnStatus] = useState<{ tested: boolean; success?: boolean; error?: string }>({ tested: false });
  const [smsConnStatus, setSmsConnStatus] = useState<{ tested: boolean; success?: boolean; error?: string }>({ tested: false });

  // ─── Mutations ─────────────────────────────────────────────
  const saveConfigMut = trpc.notifications.saveConfig.useMutation({
    onSuccess: () => { invalidateAll(); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const saveBulkMut = trpc.notifications.saveBulkConfig.useMutation({
    onSuccess: () => { invalidateAll(); toast.success(t("notifications.configSaved")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const saveTemplateMut = trpc.notifications.saveTemplate.useMutation({
    onSuccess: () => { utils.notifications.getTemplates.invalidate(); setTemplateModal(false); toast.success(t("notifications.templateSaved")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const duplicateTemplateMut = trpc.notifications.duplicateTemplate.useMutation({
    onSuccess: () => { utils.notifications.getTemplates.invalidate(); toast.success(t("notifications.templateDuplicated")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const deleteTemplateMut = trpc.notifications.deleteTemplate.useMutation({
    onSuccess: () => { utils.notifications.getTemplates.invalidate(); toast.success(t("notifications.templateDeleted")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const testEmailConnMut = trpc.notifications.testEmailConnection.useMutation({
    onSuccess: (r) => { setEmailConnStatus({ tested: true, ...r }); },
    onError: (err) => { setEmailConnStatus({ tested: true, success: false, error: err.message }); },
  });
  const testSmsConnMut = trpc.notifications.testSmsConnection.useMutation({
    onSuccess: (r) => { setSmsConnStatus({ tested: true, ...r }); },
    onError: (err) => { setSmsConnStatus({ tested: true, success: false, error: err.message }); },
  });
  const sendTestEmailMut = trpc.notifications.sendTestEmail.useMutation({
    onSuccess: (r) => { utils.notifications.getLog.invalidate(); utils.notifications.getStats.invalidate(); if (r.success) { toast.success(t("notifications.testSent")); } else { toast.error(r.error); } },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const sendTestSmsMut = trpc.notifications.sendTestSMS.useMutation({
    onSuccess: (r) => { utils.notifications.getLog.invalidate(); utils.notifications.getStats.invalidate(); if (r.success) { toast.success(t("notifications.testSent")); } else { toast.error(r.error); } },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const clearLogMut = trpc.notifications.clearLog.useMutation({
    onSuccess: () => { utils.notifications.getLog.invalidate(); utils.notifications.getStats.invalidate(); toast.success(t("notifications.logCleared")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  function invalidateAll() {
    utils.notifications.getConfig.invalidate();
    utils.notifications.getAllConfig.invalidate();
  }

  // ─── Sync config → state ───────────────────────────────────
  useEffect(() => {
    setResendKey(emailCfg.api_key || "");
    setFromEmail(emailCfg.from_email || "");
    setFromName(emailCfg.from_name || "");
    setReplyTo(emailCfg.reply_to || "");
    setBccAdmin(emailCfg.bcc_admin || "");
    setEmailSignature(emailCfg.signature || "");
  }, [emailCfg]);

  useEffect(() => {
    setTelnyxApiKey(smsCfg.api_key || "");
    setTelnyxFrom(smsCfg.from_number || "");
    setTelnyxProfileId(smsCfg.messaging_profile_id || "");
  }, [smsCfg]);

  useEffect(() => {
    setEmailEnabled(globalCfg.email_enabled !== "false");
    setSmsEnabled(globalCfg.sms_enabled !== "false");
    setAdminEmail(globalCfg.admin_notification_email || "");
    setAdminNotifyEvents(globalCfg.admin_notify_events || "rental_pending");
  }, [globalCfg]);

  // ─── Save handlers ─────────────────────────────────────────
  const saveEmailConfig = () => {
    saveBulkMut.mutate({
      configs: [
        { provider: "resend", configKey: "api_key", configValue: resendKey },
        { provider: "resend", configKey: "from_email", configValue: fromEmail },
        { provider: "resend", configKey: "from_name", configValue: fromName },
        { provider: "resend", configKey: "reply_to", configValue: replyTo },
        { provider: "resend", configKey: "bcc_admin", configValue: bccAdmin },
        { provider: "resend", configKey: "signature", configValue: emailSignature },
      ],
    });
  };

  const saveSmsConfig = () => {
    saveBulkMut.mutate({
      configs: [
        { provider: "telnyx", configKey: "api_key", configValue: telnyxApiKey },
        { provider: "telnyx", configKey: "from_number", configValue: telnyxFrom },
        { provider: "telnyx", configKey: "messaging_profile_id", configValue: telnyxProfileId },
      ],
    });
  };

  const saveGlobalConfig = () => {
    saveBulkMut.mutate({
      configs: [
        { provider: "global", configKey: "email_enabled", configValue: String(emailEnabled) },
        { provider: "global", configKey: "sms_enabled", configValue: String(smsEnabled) },
        { provider: "global", configKey: "admin_notification_email", configValue: adminEmail },
        { provider: "global", configKey: "admin_notify_events", configValue: adminNotifyEvents },
      ],
    });
  };

  const toggleEventPref = (event: string) => {
    const key = `event_${event}`;
    const current = globalCfg[key] !== "false";
    saveConfigMut.mutate({
      provider: "global",
      configKey: key,
      configValue: String(!current),
    });
  };

  // ─── Template handlers ─────────────────────────────────────
  const openAddTemplate = () => {
    setEditTemplate(null);
    setTemplateForm(emptyTemplate);
    setPreviewMode(false);
    setTemplateModal(true);
  };

  const openEditTemplate = (tmpl: NotificationTemplate) => {
    setEditTemplate(tmpl);
    setTemplateForm({
      name: tmpl.name,
      channel: tmpl.channel,
      event: tmpl.event,
      subject: tmpl.subject || "",
      body: tmpl.body,
      isActive: tmpl.isActive ?? true,
    });
    setPreviewMode(false);
    setTemplateModal(true);
  };

  const handleSaveTemplate = () => {
    if (!templateForm.name || !templateForm.body || !templateForm.event) return toast.error(t("notifications.requiredFields"));
    saveTemplateMut.mutate({
      id: editTemplate?.id,
      ...templateForm,
    });
  };

  // ─── Helpers ───────────────────────────────────────────────
  const inputClass = "bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full transition";

  const tabBtn = (t_: Tab, label: string, icon: React.ReactNode) => (
    <button
      onClick={() => setTab(t_)}
      className={`px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition ${tab === t_ ? "bg-[var(--primary)]/10 text-[var(--primary)] font-bold shadow-sm" : "text-slate-500 hover:bg-slate-100"}`}
    >
      {icon} {label}
    </button>
  );

  const connBadge = (status: { tested: boolean; success?: boolean; error?: string }) => {
    if (!status.tested) return <span className="text-xs text-slate-400">{t("notifications.notTested")}</span>;
    if (status.success) return <span className="flex items-center gap-1 text-xs text-green-600"><CheckCircle2 size={14} /> {t("notifications.connected")}</span>;
    return <span className="flex items-center gap-1 text-xs text-red-500"><XCircle size={14} /> {status.error || t("notifications.connectionFailed")}</span>;
  };

  return (
    <SettingsShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("notifications.title")}</h1>
            <p className="text-sm text-slate-500 mt-1">{t("notifications.subtitle")}</p>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          {tabBtn("general", t("notifications.general"), <Settings2 size={16} />)}
          {tabBtn("email", t("notifications.email"), <Mail size={16} />)}
          {tabBtn("sms", t("notifications.sms"), <Smartphone size={16} />)}
          {tabBtn("templates", t("notifications.templates"), <Bell size={16} />)}
          {tabBtn("events", t("notifications.events"), <Zap size={16} />)}
          {tabBtn("history", t("notifications.history"), <History size={16} />)}
          <Link
            href="/admin/notifications/greetings"
            className="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition text-slate-500 hover:bg-slate-100"
          >
            <Gift size={16} /> {t("notifications.greetings")}
          </Link>
        </div>

        {/* ═══ General Overview ═══ */}
        {tab === "general" && (
          <div className="space-y-4">
            {/* Stats — a failed query must read as "unknown", never as six zeroes */}
            {statsError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {t("notifications.statsError")}
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <StatCard icon={<TrendingUp size={18} />} label={t("notifications.totalSent")} value={statsError ? "—" : (stats?.totalSent ?? 0)} color="green" />
              <StatCard icon={<XCircle size={18} />} label={t("notifications.totalFailed")} value={statsError ? "—" : (stats?.totalFailed ?? 0)} color="red" />
              <StatCard icon={<Mail size={18} />} label={t("notifications.emailsSent")} value={statsError ? "—" : (stats?.emailSent ?? 0)} color="blue" />
              <StatCard icon={<Smartphone size={18} />} label={t("notifications.smsSent")} value={statsError ? "—" : (stats?.smsSent ?? 0)} color="purple" />
              <StatCard icon={<BarChart3 size={18} />} label={t("notifications.last24h")} value={statsError ? "—" : (stats?.last24h ?? 0)} color="amber" />
              <StatCard icon={<BarChart3 size={18} />} label={t("notifications.last7d")} value={statsError ? "—" : (stats?.last7d ?? 0)} color="indigo" />
            </div>

            {/* Channel toggles */}
            <div className="card space-y-4">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-lg bg-slate-50 text-slate-600 text-xl"><Settings2 size={20} /></div>
                <div>
                  <h2 className="text-lg font-bold text-slate-900">{t("notifications.globalSettings")}</h2>
                  <p className="text-sm text-slate-500">{t("notifications.globalSettingsDesc")}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex items-center justify-between p-4 rounded-xl bg-blue-50/50 border border-blue-100">
                  <div className="flex items-center gap-3">
                    <Mail size={20} className="text-blue-600" />
                    <div>
                      <div className="text-sm font-medium text-slate-900">{t("notifications.emailChannel")}</div>
                      <div className="text-xs text-slate-500">{t("notifications.emailChannelDesc")}</div>
                    </div>
                  </div>
                  <ToggleSwitch checked={emailEnabled} onChange={setEmailEnabled} />
                </div>

                <div className="flex items-center justify-between p-4 rounded-xl bg-green-50/50 border border-green-100">
                  <div className="flex items-center gap-3">
                    <Smartphone size={20} className="text-green-600" />
                    <div>
                      <div className="text-sm font-medium text-slate-900">{t("notifications.smsChannel")}</div>
                      <div className="text-xs text-slate-500">{t("notifications.smsChannelDesc")}</div>
                    </div>
                  </div>
                  <ToggleSwitch checked={smsEnabled} onChange={setSmsEnabled} />
                </div>
              </div>

              {/* Login OTPs bypass these toggles on purpose — say so, so nobody
                  reads "SMS off" as "the system sends nothing". */}
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{t("notifications.otpExemptNote")}</span>
              </div>

              {/* Connection status */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex items-center justify-between p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-600">{t("notifications.emailStatus")}</span>
                    {connBadge(emailConnStatus)}
                  </div>
                  <button
                    onClick={() => testEmailConnMut.mutate()}
                    disabled={testEmailConnMut.isPending}
                    className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
                  >
                    <RefreshCw size={12} className={testEmailConnMut.isPending ? "animate-spin" : ""} />
                    {t("notifications.testConnection")}
                  </button>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-600">{t("notifications.smsStatus")}</span>
                    {connBadge(smsConnStatus)}
                  </div>
                  <button
                    onClick={() => testSmsConnMut.mutate()}
                    disabled={testSmsConnMut.isPending}
                    className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
                  >
                    <RefreshCw size={12} className={testSmsConnMut.isPending ? "animate-spin" : ""} />
                    {t("notifications.testConnection")}
                  </button>
                </div>
              </div>

              {/* Admin notification */}
              <div className="border-t border-slate-200 pt-4 mt-4 space-y-3">
                <h3 className="text-sm font-semibold text-slate-700">{t("notifications.adminNotifications")}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("notifications.adminEmail")}</label>
                    <input value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} className={inputClass} placeholder="admin@company.com" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("notifications.adminEvents")}</label>
                    <input value={adminNotifyEvents} onChange={(e) => setAdminNotifyEvents(e.target.value)} className={inputClass} placeholder="rental_pending,rental_approved" />
                    <p className="text-xs text-slate-400 mt-1">{t("notifications.adminEventsHelp")}</p>
                  </div>
                </div>
              </div>

              <button onClick={saveGlobalConfig} disabled={saveBulkMut.isPending} className="btn-primary text-sm">
                {t("notifications.saveConfig")}
              </button>
            </div>
          </div>
        )}

        {/* ═══ Email Config ═══ */}
        {tab === "email" && (
          <div className="space-y-4">
            <div className="card space-y-4">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-lg bg-blue-50 text-blue-600 text-xl"><Mail size={20} /></div>
                <div>
                  <h2 className="text-lg font-bold text-slate-900">{t("notifications.resendConfig")}</h2>
                  <p className="text-sm text-slate-500">{t("notifications.resendDesc")}</p>
                </div>
                <div className="ml-auto">{connBadge(emailConnStatus)}</div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("notifications.apiKey")} *</label>
                  <div className="flex gap-2">
                    <input
                      type={showKey ? "text" : "password"}
                      value={resendKey}
                      onChange={(e) => setResendKey(e.target.value)}
                      className={inputClass}
                      placeholder="re_..."
                    />
                    <button onClick={() => setShowKey(!showKey)} className="text-slate-400 hover:text-slate-600 shrink-0">
                      {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("notifications.fromEmail")} *</label>
                  <input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} className={inputClass} placeholder="noreply@openrental.example" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("notifications.fromName")}</label>
                  <input value={fromName} onChange={(e) => setFromName(e.target.value)} className={inputClass} placeholder={t("notifications.placeholderFromName")} />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("notifications.replyTo")}</label>
                  <input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} className={inputClass} placeholder="support@openrental.example" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("notifications.bccAdmin")}</label>
                  <input value={bccAdmin} onChange={(e) => setBccAdmin(e.target.value)} className={inputClass} placeholder="admin@openrental.example" />
                  <p className="text-xs text-slate-400 mt-1">{t("notifications.bccAdminHelp")}</p>
                </div>
              </div>

              {/* Signature */}
              <div>
                <label className="block text-xs text-slate-500 mb-1">{t("notifications.emailSignature")}</label>
                <textarea
                  value={emailSignature}
                  onChange={(e) => setEmailSignature(e.target.value)}
                  rows={3}
                  className={inputClass}
                  placeholder={t("notifications.signaturePlaceholder")}
                />
              </div>

              <div className="flex gap-3">
                <button onClick={saveEmailConfig} disabled={saveBulkMut.isPending} className="btn-primary text-sm">
                  {t("notifications.saveConfig")}
                </button>
                <button
                  onClick={() => testEmailConnMut.mutate()}
                  disabled={testEmailConnMut.isPending}
                  className="btn-secondary text-sm flex items-center gap-2"
                >
                  <RefreshCw size={14} className={testEmailConnMut.isPending ? "animate-spin" : ""} />
                  {t("notifications.testConnection")}
                </button>
              </div>
            </div>

            {/* Test Email */}
            <div className="card space-y-3">
              <h3 className="text-sm font-semibold text-slate-700">{t("notifications.testEmail")}</h3>
              <div className="flex gap-3 items-end">
                <div className="flex-1">
                  <label className="block text-xs text-slate-500 mb-1">{t("notifications.recipientEmail")}</label>
                  <input type="email" value={testEmailTo} onChange={(e) => setTestEmailTo(e.target.value)} className={inputClass} placeholder="test@example.com" />
                </div>
                <button
                  onClick={() => sendTestEmailMut.mutate({ to: testEmailTo, subject: t("notifications.testEmailSubject" as never), body: t("notifications.testEmailBody" as never) })}
                  disabled={sendTestEmailMut.isPending || !testEmailTo}
                  className="btn-primary text-sm flex items-center gap-2 shrink-0"
                >
                  <Send size={16} /> {t("notifications.sendTest")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ═══ SMS Config ═══ */}
        {tab === "sms" && (
          <div className="space-y-4">
            <div className="card space-y-4">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-lg bg-green-50 text-green-600 text-xl"><Smartphone size={20} /></div>
                <div>
                  <h2 className="text-lg font-bold text-slate-900">{t("notifications.telnyxConfig")}</h2>
                  <p className="text-sm text-slate-500">{t("notifications.telnyxDesc")}</p>
                </div>
                <div className="ml-auto">{connBadge(smsConnStatus)}</div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("notifications.apiKey")} *</label>
                  <div className="flex gap-2">
                    <input
                      type={showToken ? "text" : "password"}
                      value={telnyxApiKey}
                      onChange={(e) => setTelnyxApiKey(e.target.value)}
                      className={inputClass}
                      placeholder="KEY..."
                    />
                    <button onClick={() => setShowToken(!showToken)} className="text-slate-400 hover:text-slate-600 shrink-0">
                      {showToken ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("notifications.fromNumber")} *</label>
                  <input value={telnyxFrom} onChange={(e) => setTelnyxFrom(e.target.value)} className={inputClass} placeholder="+1234567890" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("notifications.messagingProfileId")}</label>
                  <input value={telnyxProfileId} onChange={(e) => setTelnyxProfileId(e.target.value)} className={inputClass} placeholder="Optional" />
                </div>
              </div>

              <div className="flex gap-3">
                <button onClick={saveSmsConfig} disabled={saveBulkMut.isPending} className="btn-primary text-sm">
                  {t("notifications.saveConfig")}
                </button>
                <button
                  onClick={() => testSmsConnMut.mutate()}
                  disabled={testSmsConnMut.isPending}
                  className="btn-secondary text-sm flex items-center gap-2"
                >
                  <RefreshCw size={14} className={testSmsConnMut.isPending ? "animate-spin" : ""} />
                  {t("notifications.testConnection")}
                </button>
              </div>
            </div>

            {/* Test SMS */}
            <div className="card space-y-3">
              <h3 className="text-sm font-semibold text-slate-700">{t("notifications.testSms")}</h3>
              <div className="flex gap-3 items-end">
                <div className="flex-1">
                  <label className="block text-xs text-slate-500 mb-1">{t("notifications.recipientPhone")}</label>
                  <input value={testSmsTo} onChange={(e) => setTestSmsTo(e.target.value)} className={inputClass} placeholder="+1234567890" />
                </div>
                <button
                  onClick={() => sendTestSmsMut.mutate({ to: testSmsTo, body: t("notifications.testSmsBody" as never) })}
                  disabled={sendTestSmsMut.isPending || !testSmsTo}
                  className="btn-primary text-sm flex items-center gap-2 shrink-0"
                >
                  <Send size={16} /> {t("notifications.sendTest")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ═══ Templates ═══ */}
        {tab === "templates" && (
          <TemplatesTab
            templates={(templates || []) as NotificationTemplate[]}
            rentalEvents={RENTAL_EVENTS}
            templateModal={templateModal}
            setTemplateModal={setTemplateModal}
            editTemplate={editTemplate}
            templateForm={templateForm}
            setTemplateForm={setTemplateForm}
            previewMode={previewMode}
            setPreviewMode={setPreviewMode}
            onAdd={openAddTemplate}
            onEdit={openEditTemplate}
            onSave={handleSaveTemplate}
            onDuplicate={(id) => duplicateTemplateMut.mutate({ id })}
            onDelete={(id) => deleteTemplateMut.mutate({ id })}
            isSaving={saveTemplateMut.isPending}
            inputClass={inputClass}
          />
        )}

        {/* ═══ Event Preferences ═══ */}
        {tab === "events" && (
          <EventsTab
            rentalEvents={RENTAL_EVENTS}
            globalCfg={globalCfg}
            templates={(templates || []) as NotificationTemplate[]}
            onToggleEvent={toggleEventPref}
          />
        )}

        {/* ═══ History ═══ */}
        {tab === "history" && (
          <HistoryTab
            stats={stats}
            logs={logs || []}
            historyChannel={historyChannel}
            setHistoryChannel={setHistoryChannel}
            historyStatus={historyStatus}
            setHistoryStatus={setHistoryStatus}
            onClearLog={() => { if (confirm(t("notifications.clearLogConfirm"))) clearLogMut.mutate({ olderThanDays: 30 }); }}
          />
        )}
      </div>
    </SettingsShell>
  );
}
