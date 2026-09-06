/** A lost response does not prove the server rejected a write. Never replay it
 * automatically. The field inspection outbox owns its own idempotent retries. */
export const mutationDefaults = {
  retry: false,
  // Fail immediately offline instead of silently queueing money/order changes
  // for an unexpected replay when connectivity returns.
  networkMode: "always" as const,
};
