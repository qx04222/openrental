import { ReactNode, useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { useBranding } from "@/config/branding";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import CartDrawer from "@/components/CartDrawer";
import { User, MapPin, Phone, Mail, Menu, X, Search, ClipboardList } from "lucide-react";

/**
 * Shared chrome for the public, customer-facing "standalone site" surfaces
 * (home, equipment catalog, order lookup). Keeps the header/footer consistent
 * across pages so it reads as one branded website rather than separate screens.
 * Brand colors come from the graphite/red public theme (see index.css
 * [data-surface="public"]); company details come from BrandingConfig.
 */
export default function PublicLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation("rental");
  const branding = useBranding();
  const [menuOpen, setMenuOpen] = useState(false);
  const telDigits = branding.contactPhone.replace(/[^\d+]/g, "");

  // A nav tap navigates, so close the mobile menu on click.
  const navTo = () => setMenuOpen(false);

  return (
    <div className="min-h-screen flex flex-col bg-[var(--surface)]">
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80 border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <img src="/logo.png" alt={branding.companyName} className="h-9 w-auto" />
          </Link>

          <nav className="hidden md:flex items-center gap-7 text-[13px] font-semibold uppercase tracking-wide text-slate-700">
            <Link href="/rent-equipment" className="hover:text-[var(--primary)] transition-colors">{t("nav.equipment")}</Link>
            <Link href="/rental-status" className="hover:text-[var(--primary)] transition-colors">{t("nav.orderLookup")}</Link>
            <Link href="/contact" className="hover:text-[var(--primary)] transition-colors">{t("nav.contact")}</Link>
          </nav>

          <div className="flex items-center gap-2 sm:gap-3">
            <a
              href={`tel:${telDigits}`}
              className="hidden lg:flex items-center gap-1.5 text-sm font-semibold text-slate-700 hover:text-[var(--primary)] transition-colors"
            >
              <Phone size={15} /> {branding.contactPhone}
            </a>
            <CartDrawer />
            <Link
              href="/portal/login"
              className="hidden sm:flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white bg-[#1c1917] hover:bg-[#322c29] rounded-md transition-colors"
            >
              <User size={15} /> {t("nav.myAccount")}
            </Link>
            <LanguageSwitcher />
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="md:hidden inline-flex items-center justify-center h-10 w-10 -mr-1 rounded-md text-slate-700 hover:bg-slate-100 transition-colors"
              aria-label={t("nav.menu")}
              aria-expanded={menuOpen}
            >
              {menuOpen ? <X size={22} /> : <Menu size={22} />}
            </button>
          </div>
        </div>

        {/* Mobile menu — the desktop nav is hidden under md, so without this phones
            had no way to reach Equipment / Order Status / Contact / Account. */}
        {menuOpen && (
          <div className="md:hidden border-t border-slate-200 bg-white">
            <nav className="max-w-6xl mx-auto px-4 py-3 flex flex-col text-sm font-semibold uppercase tracking-wide text-slate-700">
              <Link href="/rent-equipment" onClick={navTo} className="flex items-center gap-3 py-3 border-b border-slate-100 hover:text-[var(--primary)] transition-colors">
                <Search size={18} className="text-[var(--primary)]" /> {t("nav.equipment")}
              </Link>
              <Link href="/rental-status" onClick={navTo} className="flex items-center gap-3 py-3 border-b border-slate-100 hover:text-[var(--primary)] transition-colors">
                <ClipboardList size={18} className="text-[var(--primary)]" /> {t("nav.orderLookup")}
              </Link>
              <Link href="/contact" onClick={navTo} className="flex items-center gap-3 py-3 border-b border-slate-100 hover:text-[var(--primary)] transition-colors">
                <Mail size={18} className="text-[var(--primary)]" /> {t("nav.contact")}
              </Link>
              <Link href="/portal/login" onClick={navTo} className="flex items-center gap-3 py-3 border-b border-slate-100 hover:text-[var(--primary)] transition-colors">
                <User size={18} className="text-[var(--primary)]" /> {t("nav.myAccount")}
              </Link>
              <a href={`tel:${telDigits}`} onClick={navTo} className="flex items-center gap-3 py-3 hover:text-[var(--primary)] transition-colors">
                <Phone size={18} className="text-[var(--primary)]" /> {branding.contactPhone}
              </a>
            </nav>
          </div>
        )}
      </header>

      <main className="flex-1">{children}</main>

      <footer id="contact" className="bg-[#1c1917] text-slate-300 mt-auto">
        <div className="h-1 w-full bg-[var(--primary)]" />
        <div className="max-w-6xl mx-auto px-4 py-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10">
          <div className="lg:col-span-1">
            <img src="/logo.png" alt={branding.companyName} className="h-9 w-auto bg-white rounded px-2 py-1" />
            <p className="mt-4 text-sm leading-relaxed text-slate-400 max-w-xs">{t("footer.tagline")}</p>
          </div>

          <div>
            <h4 className="font-display text-xs font-bold uppercase tracking-widest text-white mb-4">{t("footer.quickLinks")}</h4>
            <ul className="space-y-2 text-sm">
              <li><Link href="/rental-status" className="hover:text-[var(--primary)] transition-colors">{t("footer.trackOrder")}</Link></li>
              <li><Link href="/portal/login" className="hover:text-[var(--primary)] transition-colors">{t("footer.portal")}</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="font-display text-xs font-bold uppercase tracking-widest text-white mb-4">{t("footer.locations")}</h4>
            <p className="flex items-start gap-2 text-sm text-slate-400">
              <MapPin size={15} className="mt-0.5 shrink-0 text-[var(--primary)]" />
              <span>{branding.address}</span>
            </p>
          </div>

          <div>
            <h4 className="font-display text-xs font-bold uppercase tracking-widest text-white mb-4">{t("footer.contact")}</h4>
            <ul className="space-y-2 text-sm text-slate-400">
              <li className="flex items-center gap-2">
                <Phone size={15} className="text-[var(--primary)]" />
                <a href={`tel:${branding.contactPhone.replace(/[^\d+]/g, "")}`} className="hover:text-white transition-colors">{branding.contactPhone}</a>
              </li>
              <li className="flex items-center gap-2">
                <Mail size={15} className="text-[var(--primary)]" />
                <a href={`mailto:${branding.contactEmail}`} className="hover:text-white transition-colors">{branding.contactEmail}</a>
              </li>
              <li className="flex items-center gap-2 pt-1 text-slate-500">
                <span className="text-xs uppercase tracking-wide">{t("salesLabel")}:</span>
                <a href={`mailto:${branding.salesEmail}`} className="hover:text-white transition-colors">{branding.salesPhone}</a>
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t border-white/10">
          <div className="max-w-6xl mx-auto px-4 py-5 text-xs text-slate-500 flex flex-col sm:flex-row items-center justify-between gap-2">
            <span>© {branding.companyName}. {t("footer.rights")}</span>
            <span className="uppercase tracking-widest">SDLG · ARCPATH · LGMG</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
