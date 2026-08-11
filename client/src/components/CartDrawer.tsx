import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { useCart } from "@/hooks/useCart";
import { ShoppingCart, X, Trash2, Wrench, Box, Plus, Minus } from "lucide-react";

export default function CartDrawer() {
  const { t } = useTranslation("rental");
  const [, setLocation] = useLocation();
  const { items, count, updateQuantity, removeItem } = useCart();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-slate-300 rounded-lg hover:bg-slate-50"
        aria-label={t("cart.open")}
      >
        <ShoppingCart size={16} />
        <span className="hidden sm:inline">{t("cart.title")}</span>
        {count > 0 && (
          <span className="absolute -top-1.5 -right-1.5 h-5 min-w-[1.25rem] px-1 inline-flex items-center justify-center rounded-full bg-[var(--primary)] text-white text-[10px] font-bold">
            {count}
          </span>
        )}
      </button>

      {/* Portal to body: the public header has `backdrop-blur`, which makes it the
          containing block for fixed descendants — without this the drawer is clipped
          to the 64px header instead of filling the screen. */}
      {open && createPortal(
        <div className="fixed inset-0 z-50 bg-black/50 flex justify-end" onClick={() => setOpen(false)}>
          <div className="bg-white w-full max-w-md h-full overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 z-10 flex items-center justify-between p-4 border-b border-slate-200 bg-white">
              <h2 className="text-lg font-bold text-slate-900">{t("cart.title")}</h2>
              <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-900">
                <X size={20} />
              </button>
            </div>

            {items.length === 0 ? (
              <div className="p-8 text-center text-slate-400">{t("cart.empty")}</div>
            ) : (
              <>
                <div className="p-4 space-y-3">
                  {items.map((item) => {
                    const cap = item.availableFleetIds.length || 1;
                    return (
                      <div key={item.groupKey} className="flex gap-3 p-3 border border-slate-200 rounded-xl">
                        {item.imageUrl ? (
                          <img src={item.imageUrl} alt="" className="w-16 h-16 object-cover rounded-lg shrink-0" />
                        ) : (
                          <div className="w-16 h-16 bg-slate-100 rounded-lg flex items-center justify-center shrink-0">
                            {item.equipmentType === "attachment" ? <Wrench size={20} className="text-slate-400" /> : <Box size={20} className="text-slate-400" />}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-slate-900 truncate">
                            {item.brand} {item.model}
                          </div>
                          <div className="text-xs text-slate-500 truncate">{item.category || ""}</div>
                          {item.equipmentType === "attachment" && (
                            <div className="text-[10px] uppercase tracking-wide text-amber-700 mt-0.5">{t("cart.attachmentTag")}</div>
                          )}
                          <div className="mt-2 flex items-center gap-1.5">
                            <button
                              onClick={() => updateQuantity(item.groupKey, item.quantity - 1)}
                              disabled={item.quantity <= 1}
                              className="w-7 h-7 inline-flex items-center justify-center rounded border border-slate-300 disabled:opacity-30"
                            ><Minus size={12} /></button>
                            <span className="w-8 text-center text-sm">{item.quantity}</span>
                            <button
                              onClick={() => updateQuantity(item.groupKey, item.quantity + 1)}
                              disabled={item.quantity >= cap}
                              className="w-7 h-7 inline-flex items-center justify-center rounded border border-slate-300 disabled:opacity-30"
                            ><Plus size={12} /></button>
                            <button
                              onClick={() => removeItem(item.groupKey)}
                              className="ml-auto text-slate-400 hover:text-[var(--primary)]"
                              aria-label={t("cart.remove")}
                            ><Trash2 size={14} /></button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="sticky bottom-0 p-4 border-t border-slate-200 bg-white space-y-2">
                  <button
                    onClick={() => { setOpen(false); setLocation("/checkout"); }}
                    className="w-full px-4 py-2.5 text-sm font-medium text-white bg-[var(--primary)] hover:bg-[var(--accent-hover)] rounded-lg"
                  >
                    {t("cart.checkout")}
                  </button>
                  <p className="text-xs text-slate-400 text-center">{t("cart.checkoutHint")}</p>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
