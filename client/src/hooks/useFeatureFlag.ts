import { trpc } from "@/lib/trpc";

/**
 * Returns true if the given feature flag is enabled.
 *
 * Internally all callers share one tRPC query (`featureFlags.allEnabled`)
 * so opening a page with N useFeatureFlag() calls hits the server once,
 * not N times. Before this consolidation, an admin page would emit 5–10
 * featureFlags.isEnabled procedures in the same tRPC batch, padding every
 * navigation by ~300–500ms even with the server-side 60s cache.
 *
 * Components gracefully degrade while loading (returns false).
 */
export function useFeatureFlag(key: string): boolean {
  const { data } = trpc.featureFlags.allEnabled.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return data?.[key] ?? false;
}
