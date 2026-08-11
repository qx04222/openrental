/**
 * Localisable server errors.
 *
 * Background: every one of the ~456 `new TRPCError(...)` in this codebase carries
 * a hardcoded English message, and the client shows it verbatim
 * (`toast.error(err.message)` in 168 places). A Chinese user sees English — which
 * breaks the project's language rule.
 *
 * Two things make the obvious fixes wrong:
 *
 *  1. **The message cannot be translated in place.** `err.message` is read as
 *     *logic* in at least two places — client/src/main.tsx compares it against
 *     UNAUTHED_ERR_MSG to decide whether to retry, and RentalManagement/index.tsx
 *     branches on `err.message.includes("blacklisted")`. Rewriting the message
 *     (in a tRPC link, or server-side from an Accept-Language header) would
 *     silently break both.
 *  2. **A server-side i18n runtime would be a second translation stack.** The
 *     client already owns i18next and knows the user's language; the server does
 *     not need to.
 *
 * So: the English message stays exactly as-is (logic and fallback both keep
 * working), and an *optional* translation hint rides alongside it in
 * `error.data.i18nKey` / `error.data.i18nParams`. The client renders the hint
 * when present and falls back to the English message when absent — which is
 * today's behaviour, so unmigrated errors are unaffected.
 *
 * Migration is therefore incremental and per-error: wrap a throw in
 * `i18nError(...)` and add the key to the `errors.*` block of zh/en common.json.
 * Nothing has to be migrated all at once.
 */

import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/rpc";

/** Carries the translation hint on the TRPCError's `cause`. */
export class I18nErrorInfo extends Error {
  constructor(
    readonly i18nKey: string,
    readonly i18nParams?: Record<string, string | number>,
    /** The original underlying error, if this wraps one (kept for debugging). */
    readonly original?: unknown,
  ) {
    super(i18nKey);
    this.name = "I18nErrorInfo";
  }
}

/**
 * Build a TRPCError that the client can render in the user's language.
 *
 * @param code     tRPC error code, exactly as `new TRPCError({ code })`.
 * @param message  English message. Still the source of truth for logging and the
 *                 client-side fallback — write it as if no translation existed.
 * @param i18nKey  Key in the `errors.*` block of zh/en common.json.
 * @param i18nParams Interpolation values for that key.
 * @param original Underlying error to keep for debugging, if any.
 */
export function i18nError(opts: {
  code: TRPC_ERROR_CODE_KEY;
  message: string;
  i18nKey: string;
  i18nParams?: Record<string, string | number>;
  original?: unknown;
}): TRPCError {
  return new TRPCError({
    code: opts.code,
    message: opts.message,
    cause: new I18nErrorInfo(opts.i18nKey, opts.i18nParams, opts.original),
  });
}
