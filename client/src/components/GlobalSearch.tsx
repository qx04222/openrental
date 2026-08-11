import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTranslation } from "react-i18next";
import { industryI18nKey, type CustomerIndustry } from "@shared/customerClassification";
import { Search, User, Package, FileText, X, Receipt, Folder } from "lucide-react";
import { rentalStatusColors } from "@/lib/statusColors";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";
import { getGlobalSearchPath } from "@/lib/adminSearchNavigation";
import { translateDynamic } from "@/lib/i18nHelpers";

export default function GlobalSearch() {
  const { t } = useTranslation(["common", "admin"]);
  const { t: tAdmin } = useTranslation("admin");
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const searchEnabled = useFeatureFlag("global_search");

  const { data, isFetching } = trpc.search.global.useQuery(
    { query: query.trim(), limit: 5 },
    { enabled: searchEnabled && open && query.trim().length >= 1 },
  );

  // Cmd+K / Ctrl+K to open — no-op when feature flag is off
  useEffect(() => {
    if (!searchEnabled) return;
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, searchEnabled]);

  // Auto focus on open
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery("");
    }
  }, [open]);

  const navigate = useCallback((path: string) => {
    setOpen(false);
    setLocation(path);
  }, [setLocation]);

  const hasResults = data && (
    data.customers.length > 0 ||
    data.fleet.length > 0 ||
    data.rentals.length > 0 ||
    data.invoices.length > 0 ||
    data.projects.length > 0
  );
  const noResults = data && !hasResults && query.trim().length >= 1;

  if (!searchEnabled || !open) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/40" onClick={() => setOpen(false)}>
      <div
        className="max-w-xl mx-auto mt-[15vh] bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200">
          <Search size={18} className="text-slate-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("globalSearch.placeholder")}
            className="flex-1 text-sm text-slate-900 bg-transparent outline-none placeholder-gray-400"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-slate-400 hover:text-slate-600">
              <X size={14} />
            </button>
          )}
          <kbd className="hidden sm:inline text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">ESC</kbd>
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto">
          {isFetching && query.trim().length >= 1 && (
            <div className="px-4 py-6 text-center text-sm text-slate-400">
              {t("globalSearch.searching")}
            </div>
          )}

          {noResults && !isFetching && (
            <div className="px-4 py-6 text-center text-sm text-slate-400">
              {t("globalSearch.noResults")}
            </div>
          )}

          {hasResults && (
            <div className="py-2">
              {/* Customers */}
              {data.customers.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                    {t("globalSearch.customers")}
                  </div>
                  {data.customers.map((c) => (
                    <button
                      key={`c-${c.id}`}
                      onClick={() => navigate(getGlobalSearchPath("customer", c.id))}
                      className="w-full px-4 py-2 flex items-center gap-3 hover:bg-slate-50 text-left"
                    >
                      <User size={14} className="text-slate-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-900 truncate flex items-center gap-1.5">
                          <span className="truncate">{c.name}</span>
                          {c.industry && (
                            <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                              {tAdmin(industryI18nKey(c.industry as CustomerIndustry))}
                            </span>
                          )}
                          {c.preferredLanguage === "zh" && (
                            <span className="shrink-0 text-[10px] font-semibold px-1 py-0.5 rounded-full bg-amber-100 text-amber-700">中</span>
                          )}
                          {c.preferredLanguage === "en" && (
                            <span className="shrink-0 text-[10px] font-semibold px-1 py-0.5 rounded-full bg-blue-100 text-blue-700">EN</span>
                          )}
                        </div>
                        <div className="text-xs text-slate-400 truncate">
                          {[c.email, c.company !== c.name ? c.company : null, c.city].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      {c.totalRentals > 0 && (
                        <span className="text-xs text-slate-400">{c.totalRentals} {t("globalSearch.rentals")}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {/* Fleet */}
              {data.fleet.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                    {t("globalSearch.equipment")}
                  </div>
                  {data.fleet.map((f) => (
                    <button
                      key={`f-${f.id}`}
                      onClick={() => navigate(getGlobalSearchPath("fleet", f.id))}
                      className="w-full px-4 py-2 flex items-center gap-3 hover:bg-slate-50 text-left"
                    >
                      <Package size={14} className="text-slate-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-900 truncate">{f.brand} {f.model}</div>
                        <div className="text-xs text-slate-400 truncate">
                          {[f.category, f.serialNumber].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      <span className={`text-xs capitalize ${f.currentStatus === "available" ? "text-green-500" : "text-slate-400"}`}>
                        {f.currentStatus}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {/* Rentals */}
              {data.rentals.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                    {t("globalSearch.orders")}
                  </div>
                  {data.rentals.map((r) => (
                    <button
                      key={`r-${r.id}`}
                      onClick={() => navigate(getGlobalSearchPath("rental", r.id))}
                      className="w-full px-4 py-2 flex items-center gap-3 hover:bg-slate-50 text-left"
                    >
                      <FileText size={14} className="text-slate-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-900 truncate">
                          {r.rentalNumber || `#${r.id}`} — {r.customerName}
                        </div>
                        <div className="text-xs text-slate-400 truncate">
                          {[r.financialOrderNumber, r.fleetBrand, r.fleetModel].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${rentalStatusColors[r.status] || ""}`}>
                        {t(`status.${r.status}`, { ns: "common", defaultValue: r.status })}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {/* Invoices */}
              {data.invoices.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                    {t("globalSearch.invoices")}
                  </div>
                  {data.invoices.map((inv) => (
                    <button
                      key={`inv-${inv.id}`}
                      onClick={() => navigate(getGlobalSearchPath("invoice", inv.id))}
                      className="w-full px-4 py-2 flex items-center gap-3 hover:bg-slate-50 text-left"
                    >
                      <Receipt size={14} className="text-slate-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-900 truncate">
                          {inv.invoiceNumber}
                        </div>
                        <div className="text-xs text-slate-400 truncate">
                          {[inv.customerName, inv.totalAmount ? `$${inv.totalAmount}` : null].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${rentalStatusColors[inv.status] || ""}`}>
                        {translateDynamic(t, `invoices.status${inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}`, { ns: "admin", defaultValue: inv.status })}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {/* Projects */}
              {data.projects.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                    {t("globalSearch.projects")}
                  </div>
                  {data.projects.map((p) => (
                    <button
                      key={`p-${p.id}`}
                      onClick={() => navigate(getGlobalSearchPath("project", p.id))}
                      className="w-full px-4 py-2 flex items-center gap-3 hover:bg-slate-50 text-left"
                    >
                      <Folder size={14} className="text-slate-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-900 truncate">{p.name}</div>
                        <div className="text-xs text-slate-400 truncate">
                          {[p.siteAddress, p.city].filter(Boolean).join(", ")}
                        </div>
                      </div>
                      <span className="text-xs text-slate-400">
                        {t(`status.${p.status}`, { ns: "common", defaultValue: p.status })}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Hint */}
          {!query && (
            <div className="px-4 py-6 text-center text-sm text-slate-400">
              {t("globalSearch.hint")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
