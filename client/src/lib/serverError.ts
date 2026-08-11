import i18n from "@/i18n";

/**
 * Render a server error in the user's language.
 *
 * Server errors are English by construction (see server/_core/i18nError.ts for
 * why the message itself is never translated). An error thrown via `i18nError()`
 * carries `data.i18nKey` / `data.i18nParams`; everything else — the ~450 errors
 * not yet migrated — falls through to the raw English message, which is exactly
 * what the UI showed before this helper existed. So converting a call site is
 * always safe: it can only improve, never regress.
 *
 * Use at DISPLAY sites only. Never feed the result back into logic: some code
 * still branches on the raw `err.message` (main.tsx retry, RentalManagement
 * blacklist/credit checks), and those must keep reading `err.message` directly.
 */
export function serverErrorText(err: unknown): string {
  const data = (err as { data?: { i18nKey?: unknown; i18nParams?: unknown } } | null)?.data;
  const key = typeof data?.i18nKey === "string" ? data.i18nKey : undefined;
  const message = (err as { message?: unknown } | null)?.message;
  const fallback = typeof message === "string" && message ? message : i18n.t("unknownError", { ns: "common" });

  if (!key) return fallback;

  const params =
    data?.i18nParams && typeof data.i18nParams === "object"
      ? (data.i18nParams as Record<string, unknown>)
      : {};

  // defaultValue keeps a missing key from rendering as the key itself: a
  // half-migrated locale file degrades to the English message, not to
  // "errors.somethingBroke".
  return i18n.t(key, { ns: "common", defaultValue: fallback, ...params });
}
