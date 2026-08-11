import { useState } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useBranding } from "@/config/branding";
import { Lock, User } from "lucide-react";

export default function AdminLogin() {
  const { t } = useTranslation("admin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [, setLocation] = useLocation();
  const branding = useBranding();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/admin-auth/password-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "include",
      });

      const data = await res.json();
      if (!res.ok) {
        if (data.error === "TOO_MANY_ATTEMPTS") {
          const minutes = Math.ceil((data.retryAfterSeconds || 300) / 60);
          setError(t("login.tooManyAttempts", { minutes }));
        } else {
          setError(data.error || t("login.failed"));
        }
        return;
      }

      setLocation("/admin");
    } catch {
      setError(t("login.networkError"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--surface)] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo + Title */}
        <div className="text-center mb-10">
          <img src="/logo.png" alt={branding.companyName} className="h-14 mx-auto mb-5" />
          <h1 className="text-2xl font-extrabold tracking-tight text-[var(--on-surface)] font-headline">{branding.companyName}</h1>
          <p className="text-[var(--muted-foreground)] text-sm mt-1">{t("login.title")}</p>
        </div>

        {/* Login Form Card */}
        <form onSubmit={handleLogin} className="bg-[var(--surface-container-lowest)] rounded-2xl shadow-sm p-8 space-y-5">
          {error && (
            <div className="bg-[var(--error-container)] rounded-xl p-3.5 text-[var(--error)] text-sm font-medium">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="login-username" className="block text-sm font-medium text-[var(--on-surface)] mb-1.5">{t("login.username")}</label>
            <div className="relative">
              <User size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                id="login-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-[var(--surface-container-low)] border-none rounded-xl pl-10 pr-4 py-3 text-[var(--on-surface)] text-sm placeholder:text-slate-400 focus:ring-1 focus:ring-[var(--primary)]/20"
                placeholder={t("login.username")}
                required
              />
            </div>
          </div>

          <div>
            <label htmlFor="login-password" className="block text-sm font-medium text-[var(--on-surface)] mb-1.5">{t("login.password")}</label>
            <div className="relative">
              <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-[var(--surface-container-low)] border-none rounded-xl pl-10 pr-4 py-3 text-[var(--on-surface)] text-sm placeholder:text-slate-400 focus:ring-1 focus:ring-[var(--primary)]/20"
                placeholder={t("login.password")}
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full py-3 text-base"
          >
            {loading ? t("login.loggingIn") : t("login.signIn")}
          </button>
        </form>
      </div>
    </div>
  );
}
