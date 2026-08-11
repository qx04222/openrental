import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useBranding } from "@/config/branding";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { serverErrorText } from "@/lib/serverError";

type LoginMode = "otp-phone" | "otp-code" | "password";

export default function FieldAccess() {
  const branding = useBranding();
  const { t } = useTranslation("public");
  const [, setLocation] = useLocation();

  // Mode state
  const [mode, setMode] = useState<LoginMode>("otp-phone");

  // OTP state
  const [phone, setPhone] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [countdown, setCountdown] = useState(0);

  // Password state
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");

  // Countdown timer
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  // ─── Mutations ──────────────────────────────────────────────

  const requestOTP = trpc.fieldAuth.requestOTP.useMutation({
    onSuccess: () => {
      toast.success(t("fieldAccess.codeSent", "Verification code sent"));
      setMode("otp-code");
      setCountdown(60);
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const verifyOTP = trpc.fieldAuth.verifyOTP.useMutation({
    onSuccess: () => {
      toast.success(t("fieldAccess.loggedIn", "Logged in successfully"));
      setLocation("/field-dashboard");
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const passwordLogin = trpc.fieldAuth.login.useMutation({
    onSuccess: () => {
      toast.success(t("fieldAccess.loggedIn", "Logged in successfully"));
      setLocation("/field-dashboard");
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  // ─── Handlers ───────────────────────────────────────────────

  const handleRequestOTP = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      requestOTP.mutate({ phone });
    },
    [phone, requestOTP]
  );

  const handleVerifyOTP = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      verifyOTP.mutate({ phone, code: otpCode });
    },
    [phone, otpCode, verifyOTP]
  );

  const handleResend = useCallback(() => {
    requestOTP.mutate({ phone });
  }, [phone, requestOTP]);

  const handlePasswordLogin = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      passwordLogin.mutate({ identifier, password, rememberMe: true });
    },
    [identifier, password, passwordLogin]
  );

  const isPending =
    requestOTP.isPending || verifyOTP.isPending || passwordLogin.isPending;

  // ─── Render ─────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[var(--surface)] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-end mb-2">
          <LanguageSwitcher />
        </div>
        <div className="text-center mb-8">
          <img
            src="/logo.png"
            alt={branding.companyName}
            className="h-16 mx-auto mb-4"
          />
          <h1 className="text-xl font-bold text-slate-900">
            {branding.companyName}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {t("fieldAccess.title", "Field Staff Access")}
          </p>
        </div>

        {/* ── OTP Phone Step ─────────────────────────────────── */}
        {mode === "otp-phone" && (
          <form onSubmit={handleRequestOTP} className="card space-y-4">
            <div>
              <label htmlFor="field-phone" className="block text-sm text-slate-500 mb-1">
                {t("fieldAccess.phoneLabel", "Phone Number")}
              </label>
              <input
                id="field-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-3 text-slate-900"
                placeholder={t("fieldAccess.phonePlaceholder", "+1 416-000-0000")}
                required
                autoFocus
              />
            </div>

            <button
              type="submit"
              disabled={isPending}
              className="btn-primary w-full py-3 disabled:opacity-50"
            >
              {requestOTP.isPending
                ? t("fieldAccess.sending", "Sending...")
                : t("fieldAccess.sendCode", "Send Code")}
            </button>

            <button
              type="button"
              onClick={() => setMode("password")}
              className="w-full text-center text-sm text-slate-400 hover:text-slate-600 transition-colors"
            >
              {t("fieldAccess.loginWithPassword", "Login with password")}
            </button>
          </form>
        )}

        {/* ── OTP Code Step ──────────────────────────────────── */}
        {mode === "otp-code" && (
          <form onSubmit={handleVerifyOTP} className="card space-y-4">
            <p className="text-sm text-slate-500 text-center">
              {t("fieldAccess.codeSentTo", "Code sent to")} <strong>{phone}</strong>
            </p>

            <div>
              <label htmlFor="field-otp" className="block text-sm text-slate-500 mb-1">
                {t("fieldAccess.codeLabel", "Verification Code")}
              </label>
              <input
                id="field-otp"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={otpCode}
                onChange={(e) =>
                  setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-3 text-slate-900 text-center text-2xl tracking-[0.3em] font-mono"
                placeholder="000000"
                required
                autoFocus
              />
            </div>

            <button
              type="submit"
              disabled={isPending || otpCode.length !== 6}
              className="btn-primary w-full py-3 disabled:opacity-50"
            >
              {verifyOTP.isPending
                ? t("fieldAccess.verifying", "Verifying...")
                : t("fieldAccess.verify", "Verify")}
            </button>

            <div className="flex items-center justify-between text-sm">
              <button
                type="button"
                onClick={() => {
                  setMode("otp-phone");
                  setOtpCode("");
                }}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                {t("fieldAccess.changePhone", "Change phone")}
              </button>

              <button
                type="button"
                onClick={handleResend}
                disabled={countdown > 0 || requestOTP.isPending}
                className="text-blue-600 hover:text-blue-700 disabled:text-slate-300 disabled:cursor-not-allowed transition-colors"
              >
                {countdown > 0
                  ? t("fieldAccess.resendIn", "Resend in {{seconds}}s", { seconds: countdown })
                  : t("fieldAccess.resend", "Resend code")}
              </button>
            </div>
          </form>
        )}

        {/* ── Password Fallback ──────────────────────────────── */}
        {mode === "password" && (
          <form onSubmit={handlePasswordLogin} className="card space-y-4">
            <div>
              <label htmlFor="field-username" className="block text-sm text-slate-500 mb-1">
                {t("fieldAccess.username", "Username")}
              </label>
              <input
                id="field-username"
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-3 text-slate-900"
                placeholder={t("fieldAccess.usernamePlaceholder", "Enter username")}
                required
                autoFocus
              />
            </div>

            <div>
              <label htmlFor="field-password" className="block text-sm text-slate-500 mb-1">
                {t("fieldAccess.password", "Password")}
              </label>
              <input
                id="field-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-3 text-slate-900"
                placeholder={t("fieldAccess.passwordPlaceholder", "Enter password")}
                required
              />
            </div>

            <button
              type="submit"
              disabled={isPending}
              className="btn-primary w-full py-3 disabled:opacity-50"
            >
              {passwordLogin.isPending
                ? t("fieldAccess.signingIn", "Signing in...")
                : t("fieldAccess.signIn", "Sign In")}
            </button>

            <button
              type="button"
              onClick={() => setMode("otp-phone")}
              className="w-full text-center text-sm text-slate-400 hover:text-slate-600 transition-colors"
            >
              {t("fieldAccess.loginWithPhone", "Login with phone number")}
            </button>
          </form>
        )}

        <p className="text-center text-slate-400 text-xs mt-6">
          {t("fieldAccess.contactAdmin", "Contact your administrator for access")}
        </p>
      </div>
    </div>
  );
}
