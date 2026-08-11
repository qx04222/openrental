import { useState, useEffect } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/pricing";
import { rentalStatusColors } from "@/lib/statusColors";
import { useTranslation } from "react-i18next";
import PublicLayout from "@/components/public/PublicLayout";
import Seo from "@/components/Seo";
import {
  Search, Package, Calendar, MapPin, DollarSign, FileText,
  Pencil, X as XIcon, ArrowLeft, AlertTriangle, CheckCircle2,
} from "lucide-react";
import { useFormatCalendarDate, formatCalendarDateISO } from "@/lib/dateUtils";
import { serverErrorText } from "@/lib/serverError";

export default function RentalStatus() {
  const { t } = useTranslation(["public", "common"]);

  // Lookup state
  const [orderId, setOrderId] = useState("");
  const [email, setEmail] = useState("");
  const [lookupTriggered, setLookupTriggered] = useState(false);

  // Prefill + auto-lookup from query params (e.g. right after placing an order,
  // RentalRequest/Checkout redirect here with ?orderId=&email= so the customer
  // sees their order immediately instead of re-keying it).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const qOrderId = params.get("orderId");
    const qEmail = params.get("email");
    if (qOrderId) setOrderId(qOrderId);
    if (qEmail) setEmail(qEmail);
    if (qOrderId && qEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(qEmail)) {
      setLookupTriggered(true);
    }
  }, []);

  // Edit state
  const [editing, setEditing] = useState<"dates" | "address" | "notes" | "phone" | null>(null);
  const [editStartDate, setEditStartDate] = useState("");
  const [editEndDate, setEditEndDate] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [showCancel, setShowCancel] = useState(false);

  const utils = trpc.useUtils();

  const { data: rental, isLoading, error } = trpc.rentals.lookupByIdAndEmail.useQuery(
    { orderRef: orderId.trim(), email },
    { enabled: lookupTriggered && !!orderId.trim() && !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) },
  );

  const updateMut = trpc.rentals.customerUpdate.useMutation({
    onSuccess: (result) => {
      utils.rentals.lookupByIdAndEmail.invalidate();
      const wasDateEdit = editing === "dates";
      setEditing(null);
      if (wasDateEdit && result?.totalAmount) {
        toast.success(`${t("rentalStatus.updateSuccess")} — ${t("rentalStatus.newTotal")}: ${formatCurrency(parseFloat(result.totalAmount))}`);
      } else {
        toast.success(t("rentalStatus.updateSuccess"));
      }
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const cancelMut = trpc.rentals.customerCancel.useMutation({
    onSuccess: () => {
      utils.rentals.lookupByIdAndEmail.invalidate();
      setShowCancel(false);
      toast.success(t("rentalStatus.cancelSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const handleLookup = () => {
    if (!orderId || !email) return toast.error(t("rentalStatus.fillBoth"));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast.error(t("rentalStatus.invalidEmail"));
    setLookupTriggered(true);
  };

  const canModify = rental && ["pending", "approved"].includes(rental.status);

  const fmtDate = useFormatCalendarDate();

  const startEdit = (field: "dates" | "address" | "notes" | "phone") => {
    if (!rental) return;
    setEditing(field);
    if (field === "dates") {
      setEditStartDate(rental.startDate ? formatCalendarDateISO(rental.startDate) : "");
      setEditEndDate(rental.endDate ? formatCalendarDateISO(rental.endDate) : "");
    } else if (field === "address") {
      setEditAddress(rental.deliveryAddress || "");
    } else if (field === "notes") {
      setEditNotes(rental.customerNotes || "");
    } else if (field === "phone") {
      setEditPhone(rental.customerPhone || "");
    }
  };

  const saveEdit = () => {
    if (!rental || !editing) return;
    const payload: Record<string, string> = { id: String(rental.id), email };
    if (editing === "dates") {
      payload.startDate = editStartDate;
      payload.endDate = editEndDate;
    } else if (editing === "address") {
      payload.deliveryAddress = editAddress;
    } else if (editing === "notes") {
      payload.customerNotes = editNotes;
    } else if (editing === "phone") {
      payload.customerPhone = editPhone;
    }
    updateMut.mutate({
      id: rental.id,
      email,
      startDate: editing === "dates" ? editStartDate : undefined,
      endDate: editing === "dates" ? editEndDate : undefined,
      deliveryAddress: editing === "address" ? editAddress : undefined,
      customerNotes: editing === "notes" ? editNotes : undefined,
      customerPhone: editing === "phone" ? editPhone : undefined,
    });
  };

  return (
    <PublicLayout>
      <Seo title="Order Status — OpenRental Equipment Rental" path="/rental-status" noindex />
      {/* ── Hero ───────────────────────────────────────────── */}
      {/* Graphite + hazard-stripe + display eyebrow/title, matching Home/Contact/Rent */}
      <section className="relative overflow-hidden bg-[#1c1917] text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-16 h-72 w-72 opacity-10 rotate-12"
          style={{ backgroundImage: "repeating-linear-gradient(45deg, var(--primary) 0 14px, transparent 14px 28px)" }}
        />
        <div className="relative max-w-6xl mx-auto px-4 py-16 md:py-20">
          <p className="font-display text-xs sm:text-sm font-bold uppercase tracking-[0.2em] text-[var(--primary)]">
            {t("rentalStatus.eyebrow")}
          </p>
          <h1 className="font-display mt-3 max-w-2xl text-3xl sm:text-4xl md:text-5xl font-extrabold uppercase leading-[1.06] tracking-tight">
            {t("rentalStatus.title")}
          </h1>
          <p className="mt-5 max-w-xl text-base sm:text-lg text-slate-300">{t("rentalStatus.subtitle")}</p>
        </div>
      </section>

      <div className="max-w-2xl mx-auto px-4 py-10">
        {/* Lookup Form */}
        {!rental && (
          <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("rentalStatus.orderId")}</label>
              <input
                type="text"
                value={orderId}
                onChange={(e) => { setOrderId(e.target.value); setLookupTriggered(false); }}
                placeholder={t("rentalStatus.orderIdPlaceholder")}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("rentalStatus.email")}</label>
              <input
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setLookupTriggered(false); }}
                placeholder={t("rentalStatus.emailPlaceholder")}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900"
                onKeyDown={(e) => e.key === "Enter" && handleLookup()}
              />
            </div>
            <button
              onClick={handleLookup}
              disabled={isLoading}
              className="w-full bg-[var(--primary)] text-white font-medium py-3 rounded-lg hover:bg-[var(--accent-hover)] transition flex items-center justify-center gap-2"
            >
              <Search size={18} />
              {isLoading ? t("rentalStatus.searching") : t("rentalStatus.lookup")}
            </button>

            {lookupTriggered && !isLoading && !rental && !error && (
              <div className="text-center text-sm text-slate-400 py-2">
                {t("rentalStatus.notFound")}
              </div>
            )}
          </div>
        )}

        {/* Order Detail */}
        {rental && (
          <div className="space-y-4">
            <button
              onClick={() => { setLookupTriggered(false); }}
              className="text-sm text-slate-500 flex items-center gap-1 hover:text-slate-900"
            >
              <ArrowLeft size={16} /> {t("rentalStatus.searchAnother")}
            </button>

            {/* Status Header */}
            <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-sm text-slate-500">{t("rentalStatus.orderNumber")}</div>
                  <div className="text-2xl font-bold text-slate-900">{rental.rentalNumber || `#${rental.id}`}</div>
                </div>
                <span className={`px-3 py-1.5 rounded-full text-sm font-medium ${rentalStatusColors[rental.status] || ""}`}>
                  {t(`status.${rental.status}`, { ns: "common", defaultValue: rental.status })}
                </span>
              </div>

              {/* Equipment */}
              <div className="flex items-center gap-2 text-sm text-slate-700 py-2 border-t border-slate-100">
                <Package size={16} className="text-slate-400" />
                <span className="font-medium">
                  {rental.fleetBrand && rental.fleetModel ? `${rental.fleetBrand} ${rental.fleetModel}` : "-"}
                </span>
                {rental.fleetCategory && <span className="text-slate-400">· {rental.fleetCategory}</span>}
              </div>

              {/* Dates */}
              <div className="flex items-center justify-between py-2 border-t border-slate-100">
                <div className="flex items-center gap-2 text-sm text-slate-700">
                  <Calendar size={16} className="text-slate-400" />
                  <span>{fmtDate(rental.startDate)} — {fmtDate(rental.endDate)}</span>
                </div>
                {canModify && editing !== "dates" && (
                  <button onClick={() => startEdit("dates")} className="text-xs text-[var(--primary)] hover:underline flex items-center gap-1">
                    <Pencil size={12} /> {t("rentalStatus.edit")}
                  </button>
                )}
              </div>
              {editing === "dates" && (
                <div className="bg-slate-50 rounded-lg p-3 mt-1 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <input type="date" value={editStartDate} onChange={(e) => setEditStartDate(e.target.value)} className="bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-sm" />
                    <input type="date" value={editEndDate} onChange={(e) => setEditEndDate(e.target.value)} className="bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-sm" />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={saveEdit} disabled={updateMut.isPending} className="btn-primary text-xs px-3 py-1">
                      {t("rentalStatus.save")}
                    </button>
                    <button onClick={() => setEditing(null)} className="text-xs text-slate-500">{t("rentalStatus.cancel")}</button>
                  </div>
                </div>
              )}

              {/* Address */}
              {rental.deliveryAddress && (
                <div className="flex items-center justify-between py-2 border-t border-slate-100">
                  <div className="flex items-center gap-2 text-sm text-slate-700">
                    <MapPin size={16} className="text-slate-400" />
                    <span>{rental.deliveryAddress}</span>
                  </div>
                  {canModify && editing !== "address" && (
                    <button onClick={() => startEdit("address")} className="text-xs text-[var(--primary)] hover:underline flex items-center gap-1">
                      <Pencil size={12} /> {t("rentalStatus.edit")}
                    </button>
                  )}
                </div>
              )}
              {editing === "address" && (
                <div className="bg-slate-50 rounded-lg p-3 mt-1 space-y-2">
                  <input value={editAddress} onChange={(e) => setEditAddress(e.target.value)} className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-sm" />
                  <div className="flex gap-2">
                    <button onClick={saveEdit} disabled={updateMut.isPending} className="btn-primary text-xs px-3 py-1">{t("rentalStatus.save")}</button>
                    <button onClick={() => setEditing(null)} className="text-xs text-slate-500">{t("rentalStatus.cancel")}</button>
                  </div>
                </div>
              )}

              {/* Delivery method */}
              <div className="flex items-center gap-2 text-sm text-slate-500 py-2 border-t border-slate-100">
                <span>{({
                  pickup: t("rentalStatus.deliveryPickup"),
                  delivery: t("rentalStatus.deliveryDelivery"),
                  delivery_and_return: t("rentalStatus.deliveryDeliveryAndReturn"),
                } as Record<string, string>)[rental.deliveryMethod || "pickup"] || rental.deliveryMethod}</span>
                · <span>{({
                  none: t("rentalStatus.insuranceNone"),
                  basic: t("rentalStatus.insuranceBasic"),
                  full: t("rentalStatus.insuranceFull"),
                } as Record<string, string>)[rental.insuranceType || "none"] || rental.insuranceType}</span>
              </div>
            </div>

            {/* Pricing */}
            <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5">
              <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                <DollarSign size={16} /> {t("rentalStatus.pricing")}
              </h3>
              <div className="space-y-1 text-sm">
                {rental.rentalFee && <div className="flex justify-between"><span className="text-slate-500">{t("rentalStatus.rentalFee")}</span><span>{formatCurrency(Number(rental.rentalFee))}</span></div>}
                {rental.freightCost && Number(rental.freightCost) > 0 && <div className="flex justify-between"><span className="text-slate-500">{t("rentalStatus.freight")}</span><span>{formatCurrency(Number(rental.freightCost))}</span></div>}
                {rental.insuranceCost && Number(rental.insuranceCost) > 0 && <div className="flex justify-between"><span className="text-slate-500">{t("rentalStatus.insurance")}</span><span>{formatCurrency(Number(rental.insuranceCost))}</span></div>}
                {rental.taxAmount && Number(rental.taxAmount) > 0 && <div className="flex justify-between"><span className="text-slate-500">{t("rentalStatus.tax")}</span><span>{formatCurrency(Number(rental.taxAmount))}</span></div>}
                <div className="flex justify-between pt-2 border-t border-slate-200 font-bold">
                  <span>{t("rentalStatus.total")}</span>
                  <span className="text-[var(--primary)]">{rental.totalAmount ? formatCurrency(Number(rental.totalAmount)) : "-"}</span>
                </div>
                {rental.depositAmount && (
                  <div className="flex justify-between text-xs text-slate-400">
                    <span>{t("rentalStatus.deposit")}</span>
                    <span>{formatCurrency(Number(rental.depositAmount))}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Contact & Notes */}
            <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5 space-y-3">
              <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <FileText size={16} /> {t("rentalStatus.details")}
              </h3>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">{t("rentalStatus.phone")}: {rental.customerPhone || "-"}</span>
                {canModify && editing !== "phone" && (
                  <button onClick={() => startEdit("phone")} className="text-xs text-[var(--primary)] hover:underline flex items-center gap-1">
                    <Pencil size={12} />
                  </button>
                )}
              </div>
              {editing === "phone" && (
                <div className="bg-slate-50 rounded-lg p-3 space-y-2">
                  <input value={editPhone} onChange={(e) => setEditPhone(e.target.value)} className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-sm" />
                  <div className="flex gap-2">
                    <button onClick={saveEdit} disabled={updateMut.isPending} className="btn-primary text-xs px-3 py-1">{t("rentalStatus.save")}</button>
                    <button onClick={() => setEditing(null)} className="text-xs text-slate-500">{t("rentalStatus.cancel")}</button>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">{t("rentalStatus.notes")}: {rental.customerNotes || "-"}</span>
                {canModify && editing !== "notes" && (
                  <button onClick={() => startEdit("notes")} className="text-xs text-[var(--primary)] hover:underline flex items-center gap-1">
                    <Pencil size={12} />
                  </button>
                )}
              </div>
              {editing === "notes" && (
                <div className="bg-slate-50 rounded-lg p-3 space-y-2">
                  <textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows={3} className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-sm" />
                  <div className="flex gap-2">
                    <button onClick={saveEdit} disabled={updateMut.isPending} className="btn-primary text-xs px-3 py-1">{t("rentalStatus.save")}</button>
                    <button onClick={() => setEditing(null)} className="text-xs text-slate-500">{t("rentalStatus.cancel")}</button>
                  </div>
                </div>
              )}

              {/* Contract link */}
              {rental.contractUrl && (
                <a
                  href={rental.contractUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                >
                  <FileText size={14} /> {t("rentalStatus.viewContract")}
                </a>
              )}
            </div>

            {/* Cancel order */}
            {canModify && (
              <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5">
                {!showCancel ? (
                  <button
                    onClick={() => setShowCancel(true)}
                    className="w-full text-[var(--primary)] border border-[#2563EB] rounded-lg py-2.5 text-sm font-medium hover:bg-[var(--primary)]/5 transition flex items-center justify-center gap-2"
                  >
                    <AlertTriangle size={16} /> {t("rentalStatus.cancelOrder")}
                  </button>
                ) : (
                  <div className="space-y-3">
                    <div className="text-sm font-medium text-[var(--primary)] flex items-center gap-2">
                      <AlertTriangle size={16} /> {t("rentalStatus.cancelConfirm")}
                    </div>
                    <textarea
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                      placeholder={t("rentalStatus.cancelReasonPlaceholder")}
                      rows={2}
                      className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => cancelMut.mutate({ id: rental.id, email, reason: cancelReason || undefined })}
                        disabled={cancelMut.isPending}
                        className="bg-[var(--primary)] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition"
                      >
                        {cancelMut.isPending ? t("rentalStatus.cancelling") : t("rentalStatus.confirmCancel")}
                      </button>
                      <button onClick={() => setShowCancel(false)} className="text-sm text-slate-500">
                        {t("rentalStatus.keepOrder")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Already completed/cancelled */}
            {rental.status === "completed" && (
              <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 rounded-lg p-3">
                <CheckCircle2 size={16} /> {t("rentalStatus.completed")}
              </div>
            )}
            {rental.status === "cancelled" && (
              <div className="flex items-center gap-2 text-sm text-slate-500 bg-slate-100 rounded-lg p-3">
                <XIcon size={16} /> {t("rentalStatus.cancelled")}
              </div>
            )}
          </div>
        )}

        {/* Always-available help link — also the reliable path to Contact on this
            short page, where the old footer #contact anchor barely scrolled. */}
        <p className="mt-8 text-center text-sm text-slate-500">
          {t("rentalStatus.needHelp")}{" "}
          <Link href="/contact" className="text-[var(--primary)] font-medium hover:underline">
            {t("rentalStatus.contactUs")}
          </Link>
        </p>
      </div>
    </PublicLayout>
  );
}
