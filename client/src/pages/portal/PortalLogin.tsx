import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { useBranding } from "@/config/branding";
import { toast } from "sonner";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { Phone, ShieldCheck, Home } from "lucide-react";
import { serverErrorText } from "@/lib/serverError";

export default function PortalLogin() {
  const { t } = useTranslation("portal");
  const branding = useBranding();
  const [, setLocation] = useLocation();

  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);

  // Check if already logged in
  const { data: me } = trpc.customerAuth.me.useQuery(undefined, { retry: false });
  useEffect(() => {
    if (me) setLocation("/portal");
  }, [me, setLocation]);

  // Countdown timer
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const requestOTP = trpc.customerAuth.requestOTP.useMutation({
    onSuccess: () => {
      toast.success(t("login.codeSent"));
      setStep("code");
      setCountdown(60);
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const verifyOTP = trpc.customerAuth.verifyOTP.useMutation({
    onSuccess: () => {
      toast.success(t("login.loginSuccess"));
      setLocation("/portal");
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const handleSendCode = () => {
    if (!phone.trim()) return;
    requestOTP.mutate({ phone: phone.trim() });
  };

  const handleVerify = () => {
    if (!code.trim() || code.length < 6) return;
    verifyOTP.mutate({ phone: phone.trim(), code: code.trim() });
  };

  const handleResend = () => {
    requestOTP.mutate({ phone: phone.trim() });
  };

  return (
    <div className="min-h-screen bg-[var(--surface)] flex flex-col">
      {/* Header */}
      <header className="h-16 border-b border-[var(--outline-variant)] bg-[var(--surface-container-lowest)] flex items-center px-6 justify-between">
        <Link href="/" className="flex items-center gap-3">
          <img src="/logo.png" alt={branding.companyName} className="h-10" />
          <span className="text-lg font-semibold text-slate-900 hidden sm:inline">{branding.companyName}</span>
        </Link>
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-[var(--primary)] transition"
          >
            <Home size={16} />
            <span className="hidden sm:inline">{t("nav.backToSite")}</span>
          </Link>
          <LanguageSwitcher />
        </div>
      </header>

      {/* Login Card */}
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 shadow-sm p-8">
            <div className="text-center mb-8">
              <div className="w-16 h-16 bg-[var(--primary)]/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <ShieldCheck className="w-8 h-8 text-[var(--primary)]" />
              </div>
              <h1 className="text-2xl font-bold text-slate-900">{t("login.title")}</h1>
              <p className="text-slate-500 mt-2">{t("login.subtitle")}</p>
            </div>

            {step === "phone" ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    {t("login.phoneLabel")}
                  </label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder={t("login.phonePlaceholder")}
                      className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)] outline-none transition"
                      onKeyDown={(e) => e.key === "Enter" && handleSendCode()}
                    />
                  </div>
                </div>
                <button
                  onClick={handleSendCode}
                  disabled={!phone.trim() || requestOTP.isPending}
                  className="w-full py-3 bg-[var(--primary)] hover:bg-[var(--accent-hover)] disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition"
                >
                  {requestOTP.isPending ? t("login.sending") : t("login.sendCode")}
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    {t("login.codeLabel")}
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    placeholder={t("login.codePlaceholder")}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-300 rounded-lg text-slate-900 text-center text-2xl tracking-[0.5em] font-mono focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)] outline-none transition"
                    autoFocus
                    onKeyDown={(e) => e.key === "Enter" && handleVerify()}
                  />
                </div>
                <button
                  onClick={handleVerify}
                  disabled={code.length < 6 || verifyOTP.isPending}
                  className="w-full py-3 bg-[var(--primary)] hover:bg-[var(--accent-hover)] disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition"
                >
                  {verifyOTP.isPending ? t("login.verifying") : t("login.verify")}
                </button>
                <div className="flex items-center justify-between text-sm">
                  <button
                    onClick={() => { setStep("phone"); setCode(""); }}
                    className="text-[var(--primary)] hover:underline"
                  >
                    {t("login.changePhone")}
                  </button>
                  <button
                    onClick={handleResend}
                    disabled={countdown > 0 || requestOTP.isPending}
                    className="text-slate-500 hover:text-slate-900 disabled:text-slate-300 disabled:cursor-not-allowed"
                  >
                    {countdown > 0
                      ? t("login.resendIn", { seconds: countdown })
                      : t("login.resendCode")}
                  </button>
                </div>
              </div>
            )}
          </div>

          <p className="text-center text-xs text-slate-400 mt-6">
            {branding.companyName} &middot; {branding.contactPhone}
          </p>
        </div>
      </div>
    </div>
  );
}
