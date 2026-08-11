import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { useCart } from "@/hooks/useCart";
import { useBranding } from "@/config/branding";
import { toast } from "sonner";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import AddressAutocomplete from "@/components/AddressAutocomplete";
import type { AddressComponents } from "@/components/AddressAutocomplete";
import ProvinceSelect from "@/components/ProvinceSelect";
import { Trash2, Plus, Minus, ArrowLeft, Wrench, Box, Calendar } from "lucide-react";
import { formatCurrency } from "@/lib/pricing";
import { formatCalendarDateISO } from "@/lib/dateUtils";
import { serverErrorText } from "@/lib/serverError";

/**
 * Cart-style multi-item checkout with the same instant-quote experience as
 * the single-item rental flow. Calls rentals.previewMultiItemQuote on every
 * material change so the customer always sees a real total before submit.
 */
export default function Checkout() {
  const { t } = useTranslation(["rental", "common"]);
  const branding = useBranding();
  const [, setLocation] = useLocation();
  const { items, count, updateQuantity, updateItem, removeItem, clear } = useCart();

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [deliveryMethod, setDeliveryMethod] = useState<"pickup" | "delivery" | "delivery_and_return">("pickup");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryProvince, setDeliveryProvince] = useState("ON");
  const [insuranceType, setInsuranceType] = useState<"none" | "basic" | "full">("none");
  const [projectDescription, setProjectDescription] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerCompany, setCustomerCompany] = useState("");

  // UI: per-item "different dates" expansion state
  const [datesExpanded, setDatesExpanded] = useState<Record<string, boolean>>({});

  // Toronto's "today" (see RentalRequest) — correct min regardless of viewer TZ.
  const today = formatCalendarDateISO(new Date());

  // Insurance options (admin-configurable rates)
  const { data: insuranceOpts } = trpc.rentalSettings.getInsuranceOptions.useQuery();
  const insBasicPct = insuranceOpts?.basic?.costPercentage ?? 0.10;
  const insFullPct = insuranceOpts?.full?.costPercentage ?? 0.20;

  // ── Returning-customer detection (email lookup) ──
  const { data: returning } = trpc.customers.lookupByEmail.useQuery(
    { email: customerEmail },
    { enabled: !!customerEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) },
  );
  const [returningApplied, setReturningApplied] = useState(false);
  useEffect(() => {
    if (returning && !returningApplied) {
      const c = returning.customer;
      if (c.name && !customerName) setCustomerName(c.name);
      if (c.phone && !customerPhone) setCustomerPhone(c.phone);
      if (c.company && !customerCompany) setCustomerCompany(c.company);
      if (returning.lastRental?.deliveryAddress && !deliveryAddress) setDeliveryAddress(returning.lastRental.deliveryAddress);
      setReturningApplied(true);
      toast.success(t("checkout.returningApplied"));
    }
  }, [returning, returningApplied, customerName, customerPhone, customerCompany, deliveryAddress, t]);

  // ── Live quote preview ──
  const taxProvince = deliveryMethod !== "pickup" && deliveryProvince ? deliveryProvince : "ON";
  const quoteEnabled = !!(startDate && endDate && new Date(endDate) > new Date(startDate) && items.length > 0);
  const quoteInput = useMemo(() => ({
    startDate, endDate,
    deliveryMethod,
    deliveryAddress: deliveryAddress || undefined,
    taxProvince,
    insuranceType,
    items: items.map((i) => ({
      equipmentModelId: i.equipmentModelId,
      fleetIds: i.availableFleetIds,
      itemType: i.equipmentType,
      quantity: i.quantity,
      startDate: i.startDate ?? null,
      endDate: i.endDate ?? null,
    })),
  }), [startDate, endDate, deliveryMethod, deliveryAddress, taxProvince, insuranceType, items]);
  const { data: quote, isFetching: quoteFetching } = trpc.rentals.previewMultiItemQuote.useQuery(
    quoteInput,
    { enabled: quoteEnabled, staleTime: 5_000 },
  );

  const create = trpc.rentals.createWithItems.useMutation({
    onSuccess: (res) => {
      toast.success(t("checkout.success", { num: res.rental.rentalNumber || res.rental.id }));
      clear();
      setLocation("/rental-status");
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const validate = (): string | null => {
    if (items.length === 0) return t("checkout.errEmpty");
    if (!customerName.trim()) return t("checkout.errName");
    if (!customerPhone.trim()) return t("checkout.errPhone");
    if (!startDate) return t("checkout.errStart");
    if (!endDate) return t("checkout.errEnd");
    if (new Date(endDate) <= new Date(startDate)) return t("checkout.errOrder");
    if (deliveryMethod !== "pickup" && !deliveryAddress.trim()) return t("checkout.errAddr");
    for (const it of items) {
      if (it.equipmentType === "attachment" && !it.compatibilityAcknowledged) {
        return t("checkout.errAttachmentAck", { brand: it.brand, model: it.model });
      }
      if (it.startDate && it.endDate && new Date(it.endDate) <= new Date(it.startDate)) {
        return t("checkout.errLineOrder", { brand: it.brand, model: it.model });
      }
    }
    return null;
  };

  const handleSubmit = () => {
    const err = validate();
    if (err) { toast.error(err); return; }
    create.mutate({
      customerName,
      customerEmail: customerEmail || undefined,
      customerPhone,
      customerCompany: customerCompany || undefined,
      startDate,
      endDate,
      deliveryMethod,
      deliveryAddress: deliveryAddress || undefined,
      deliveryProvince: deliveryMethod !== "pickup" ? deliveryProvince : undefined,
      taxProvince,
      insuranceType,
      projectDescription: projectDescription || undefined,
      items: items.map((i) => ({
        equipmentModelId: i.equipmentModelId,
        availableFleetIds: i.availableFleetIds,
        itemType: i.equipmentType,
        quantity: i.quantity,
        startDate: i.startDate ?? null,
        endDate: i.endDate ?? null,
        dailyRate: i.dailyRate ?? undefined,
        weeklyRate: i.weeklyRate ?? undefined,
        monthlyRate: i.monthlyRate ?? undefined,
        customerEquipmentNote: i.customerEquipmentNote,
        compatibilityAcknowledgedAt: i.compatibilityAcknowledged ? new Date().toISOString() : undefined,
      })),
    });
  };

  const handleAddrSelect = (parts: AddressComponents) => {
    if (parts.formattedAddress) setDeliveryAddress(parts.formattedAddress);
    if (parts.province) setDeliveryProvince(parts.province);
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <button onClick={() => setLocation("/rent-equipment")} className="text-sm text-slate-500 hover:text-slate-900 inline-flex items-center gap-1">
            <ArrowLeft size={14} /> {t("checkout.back")}
          </button>
          <h1 className="text-lg font-bold text-slate-900">{t("checkout.title")}</h1>
          <LanguageSwitcher />
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        {items.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
            <p className="text-slate-500 mb-4">{t("checkout.empty")}</p>
            <button onClick={() => setLocation("/rent-equipment")} className="btn-primary">{t("checkout.browse")}</button>
          </div>
        ) : (
          <>
            {/* Cart items */}
            <section className="bg-white border border-slate-200 rounded-xl">
              <div className="px-4 py-3 border-b border-slate-100">
                <h2 className="text-sm font-semibold text-slate-700">{t("checkout.items", { count })}</h2>
              </div>
              <div className="divide-y divide-slate-100">
                {items.map((it, idx) => {
                  const cap = it.availableFleetIds.length || 1;
                  const isAttach = it.equipmentType === "attachment";
                  const expanded = datesExpanded[it.groupKey];
                  const lineQuote = quote?.perLine?.[idx];
                  return (
                    <div key={it.groupKey} className="p-4 flex gap-3">
                      {it.imageUrl ? (
                        <img src={it.imageUrl} alt="" className="w-20 h-20 object-cover rounded-lg shrink-0" />
                      ) : (
                        <div className="w-20 h-20 bg-slate-100 rounded-lg flex items-center justify-center shrink-0">
                          {isAttach ? <Wrench size={22} className="text-slate-400" /> : <Box size={22} className="text-slate-400" />}
                        </div>
                      )}
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-900 truncate">{it.brand} {it.model}</div>
                            <div className="text-xs text-slate-500 truncate">{it.category || ""}</div>
                            {isAttach && (
                              <div className="text-[10px] uppercase tracking-wide text-amber-700 mt-0.5">{t("cart.attachmentTag")}</div>
                            )}
                          </div>
                          <button onClick={() => removeItem(it.groupKey)} className="text-slate-400 hover:text-[var(--primary)]" aria-label={t("cart.remove")}>
                            <Trash2 size={16} />
                          </button>
                        </div>

                        <div className="flex items-center gap-1.5 flex-wrap">
                          <button onClick={() => updateQuantity(it.groupKey, it.quantity - 1)} disabled={it.quantity <= 1}
                            className="w-7 h-7 inline-flex items-center justify-center rounded border border-slate-300 disabled:opacity-30">
                            <Minus size={12} />
                          </button>
                          <span className="w-8 text-center text-sm">{it.quantity}</span>
                          <button onClick={() => updateQuantity(it.groupKey, it.quantity + 1)} disabled={it.quantity >= cap}
                            className="w-7 h-7 inline-flex items-center justify-center rounded border border-slate-300 disabled:opacity-30">
                            <Plus size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDatesExpanded((p) => ({ ...p, [it.groupKey]: !expanded }))}
                            className="ml-auto text-xs text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
                          >
                            <Calendar size={12} />
                            {expanded ? t("checkout.useSharedDates") : t("checkout.useDifferentDates")}
                          </button>
                          {lineQuote && (
                            <span className="text-xs text-slate-700 font-medium ml-auto sm:ml-0">
                              {formatCurrency(lineQuote.lineSubtotal)}
                            </span>
                          )}
                        </div>

                        {expanded && (
                          <div className="grid grid-cols-2 gap-2">
                            <input type="date" value={it.startDate ?? ""} min={today}
                              onChange={(e) => updateItem(it.groupKey, { startDate: e.target.value || null })}
                              className="bg-slate-50 border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
                            <input type="date" value={it.endDate ?? ""} min={it.startDate || today}
                              onChange={(e) => updateItem(it.groupKey, { endDate: e.target.value || null })}
                              className="bg-slate-50 border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
                          </div>
                        )}

                        {isAttach && (
                          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
                            <input
                              value={it.customerEquipmentNote ?? ""}
                              onChange={(e) => updateItem(it.groupKey, { customerEquipmentNote: e.target.value })}
                              placeholder={t("request.ownMachinePlaceholder")}
                              className="w-full bg-white border border-amber-300 rounded px-2 py-1.5 text-sm"
                            />
                            <label className="flex items-start gap-2 text-xs text-amber-900 cursor-pointer">
                              <input type="checkbox" checked={!!it.compatibilityAcknowledged}
                                onChange={(e) => updateItem(it.groupKey, { compatibilityAcknowledged: e.target.checked })}
                                className="mt-0.5 rounded border-amber-400 text-amber-600" />
                              <span>{t("request.attachmentAckLabel")}</span>
                            </label>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Shared dates */}
            <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <h2 className="text-sm font-semibold text-slate-700">{t("checkout.dates")}</h2>
              <p className="text-xs text-slate-400">{t("checkout.sharedDatesHint")}</p>
              <div className="grid grid-cols-2 gap-3">
                <input type="date" value={startDate} min={today} onChange={(e) => setStartDate(e.target.value)}
                  className="bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm" />
                <input type="date" value={endDate} min={startDate || today} onChange={(e) => setEndDate(e.target.value)}
                  className="bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm" />
              </div>
            </section>

            {/* Customer */}
            <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <h2 className="text-sm font-semibold text-slate-700">{t("checkout.customer")}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input value={customerName} onChange={(e) => setCustomerName(e.target.value)}
                  placeholder={t("checkout.name") + " *"}
                  className="bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm" />
                <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder={t("checkout.phone") + " *"}
                  className="bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm" />
                <input type="email" value={customerEmail} onChange={(e) => { setCustomerEmail(e.target.value); setReturningApplied(false); }}
                  placeholder={t("checkout.email")}
                  className="bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm" />
                <input value={customerCompany} onChange={(e) => setCustomerCompany(e.target.value)}
                  placeholder={t("checkout.company")}
                  className="bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm" />
              </div>
            </section>

            {/* Delivery */}
            <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <h2 className="text-sm font-semibold text-slate-700">{t("checkout.delivery")}</h2>
              <div className="space-y-2">
                {(["pickup", "delivery", "delivery_and_return"] as const).map((m) => (
                  <label key={m} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="radio" name="dm" value={m} checked={deliveryMethod === m} onChange={() => setDeliveryMethod(m)} />
                    <span>{t(`checkout.dm.${m}`)}</span>
                  </label>
                ))}
              </div>
              {deliveryMethod !== "pickup" && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2">
                    <AddressAutocomplete value={deliveryAddress} onChange={setDeliveryAddress} onPlaceSelected={handleAddrSelect}
                      placeholder={t("checkout.address") + " *"} />
                  </div>
                  <ProvinceSelect value={deliveryProvince} onChange={setDeliveryProvince} />
                </div>
              )}
            </section>

            {/* Insurance */}
            <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <h2 className="text-sm font-semibold text-slate-700">{t("checkout.insurance")}</h2>
              <select value={insuranceType} onChange={(e) => setInsuranceType(e.target.value as typeof insuranceType)}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm">
                <option value="none">{t("checkout.insNone")}</option>
                <option value="basic">{t("checkout.insBasic")} ({(insBasicPct * 100).toFixed(0)}%)</option>
                <option value="full">{t("checkout.insFull")} ({(insFullPct * 100).toFixed(0)}%)</option>
              </select>
              <p className="text-xs text-slate-400">{t("checkout.insRateHint")}</p>
            </section>

            {/* Project description */}
            <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <h2 className="text-sm font-semibold text-slate-700">{t("checkout.project")}</h2>
              <textarea value={projectDescription} onChange={(e) => setProjectDescription(e.target.value)}
                placeholder={t("checkout.projectPlaceholder")} rows={3}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm resize-none" />
            </section>

            {/* Pricing summary */}
            <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-2 text-sm">
              <h2 className="text-sm font-semibold text-slate-700 mb-2">{t("checkout.summary")}</h2>
              {!quoteEnabled ? (
                <p className="text-slate-400 text-xs">{t("checkout.quoteHintFillDates")}</p>
              ) : quoteFetching && !quote ? (
                <p className="text-slate-400 text-xs">{t("checkout.quoteCalculating")}</p>
              ) : quote ? (
                <>
                  <div className="flex justify-between text-slate-600"><span>{t("checkout.rentalFee")}</span><span>{formatCurrency(quote.rentalFee)}</span></div>
                  <div className="flex justify-between text-slate-600"><span>{t("checkout.freight")}</span><span>{formatCurrency(quote.freightCost)}</span></div>
                  {quote.insuranceCost > 0 && (
                    <div className="flex justify-between text-slate-600"><span>{t("checkout.insuranceLine")}</span><span>{formatCurrency(quote.insuranceCost)}</span></div>
                  )}
                  <div className="flex justify-between text-slate-600"><span>{quote.taxBreakdown || t("checkout.tax")}</span><span>{formatCurrency(quote.taxAmount)}</span></div>
                  <div className="border-t border-slate-200 pt-2 mt-2 flex justify-between font-bold text-slate-900">
                    <span>{t("checkout.total")}</span><span>{formatCurrency(quote.totalAmount)}</span>
                  </div>
                  {quote.depositAmount > 0 && (
                    <div className="flex justify-between text-xs text-slate-500 pt-1"><span>{t("checkout.deposit")}</span><span>{formatCurrency(quote.depositAmount)}</span></div>
                  )}
                  {quote.warnings && quote.warnings.length > 0 && (
                    <div className="text-xs text-amber-700 mt-2">{quote.warnings.join(" · ")}</div>
                  )}
                </>
              ) : null}
            </section>

            <button
              onClick={handleSubmit}
              disabled={create.isPending || !quoteEnabled}
              className="w-full px-4 py-3 text-sm font-semibold text-white bg-[var(--primary)] hover:bg-[var(--accent-hover)] disabled:bg-slate-300 rounded-lg"
            >
              {create.isPending ? t("checkout.submitting") : t("checkout.submit", { count })}
            </button>
            <p className="text-xs text-slate-400 text-center">{t("checkout.followUpHint")}</p>
          </>
        )}
      </main>

      <footer className="py-6 text-center text-xs text-slate-400">
        {branding.companyName} · {branding.contactEmail}
      </footer>
    </div>
  );
}
