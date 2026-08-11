import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, Redirect } from "wouter";
import { trpc } from "@/lib/trpc";
import { useBranding } from "@/config/branding";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import {
  LayoutDashboard,
  Package,
  Receipt,
  Wallet,
  LogOut,
  Menu,
  X,
  Home,
} from "lucide-react";

interface PortalLayoutProps {
  children: ReactNode;
}

export default function PortalLayout({ children }: PortalLayoutProps) {
  const { t } = useTranslation("portal");
  const branding = useBranding();
  const [location] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const { data: customer, isLoading } = trpc.customerAuth.me.useQuery(undefined, {
    retry: false,
  });

  const logoutMut = trpc.customerAuth.logout.useMutation({
    onSuccess: () => {
      window.location.href = "/portal/login";
    },
  });

  const navItems = [
    { icon: LayoutDashboard, label: t("nav.dashboard"), path: "/portal" },
    { icon: Package, label: t("nav.orders"), path: "/portal/orders" },
    { icon: Receipt, label: t("nav.invoices"), path: "/portal/invoices" },
    { icon: Wallet, label: t("nav.deposits"), path: "/portal/deposits" },
  ];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[var(--surface)]">
        <div className="text-slate-500">{t("loading", { ns: "common" })}</div>
      </div>
    );
  }

  if (!customer) {
    return <Redirect to="/portal/login" />;
  }

  const customerName = (customer as { name?: string }).name || (customer as { phone?: string }).phone || "Customer";

  return (
    <div className="min-h-screen bg-[var(--surface)]">
      {/* Top Nav Bar */}
      <header className="h-16 bg-[var(--surface-container-lowest)] border-b border-[var(--outline-variant)] sticky top-0 z-40">
        <div className="h-full max-w-7xl mx-auto px-4 flex items-center justify-between">
          {/* Logo & Company */}
          <div className="flex items-center gap-3">
            <button
              className="md:hidden text-slate-600 mr-2"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Toggle menu"
            >
              {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
            </button>
            <Link href="/portal" className="flex items-center gap-2">
              <img src="/logo.png" alt={branding.companyName} className="h-8" />
              <span className="font-semibold text-slate-900 hidden sm:inline">{branding.companyName}</span>
            </Link>
          </div>

          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = item.path === "/portal"
                ? location === "/portal"
                : location.startsWith(item.path);
              return (
                <Link
                  key={item.path}
                  href={item.path}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition ${
                    isActive
                      ? "bg-[var(--primary)]/10 text-[var(--primary)]"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  <Icon size={18} />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* Right side */}
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-[var(--primary)] transition"
            >
              <Home size={16} />
              <span className="hidden sm:inline">{t("nav.backToSite")}</span>
            </Link>
            <LanguageSwitcher />
            <span className="text-sm text-slate-600 hidden sm:inline">{customerName}</span>
            <button
              onClick={() => logoutMut.mutate()}
              className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900 transition"
              aria-label="Logout"
            >
              <LogOut size={18} />
              <span className="hidden sm:inline">{t("signOut", { ns: "common" })}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Nav */}
      {mobileMenuOpen && (
        <div className="md:hidden bg-[var(--surface-container-lowest)] border-b border-[var(--outline-variant)] px-4 py-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = item.path === "/portal"
              ? location === "/portal"
              : location.startsWith(item.path);
            return (
              <Link
                key={item.path}
                href={item.path}
                onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm ${
                  isActive
                    ? "bg-[var(--primary)]/10 text-[var(--primary)] font-medium"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                <Icon size={18} />
                {item.label}
              </Link>
            );
          })}
          <Link
            href="/"
            onClick={() => setMobileMenuOpen(false)}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-600 hover:bg-slate-50"
          >
            <Home size={18} />
            {t("nav.backToSite")}
          </Link>
        </div>
      )}

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        {children}
      </main>
    </div>
  );
}
