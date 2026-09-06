import { createOperationalRefresh, shouldRefreshOperations } from "./lib/operationalRefresh";
import { mutationDefaults } from "./lib/networkPolicy";
import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from "../../shared/const";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { registerServiceWorker, setupInstallPrompt, applyManifestForRoute } from "./lib/pwa";
import i18n from "./i18n";
import { toast } from "sonner";
import "./index.css";

const shouldRetry = (failureCount: number, error: unknown): boolean => {
  if (failureCount >= 3) return false;
  if (error instanceof TRPCClientError) {
    const code = error.data?.code;
    const retryableCodes = ["INTERNAL_SERVER_ERROR", "TIMEOUT", "TOO_MANY_REQUESTS"];
    if (code && !retryableCodes.includes(code)) return false;
    if (error.message === UNAUTHED_ERR_MSG) return false;
  }
  return true;
};

const getRetryDelay = (attemptIndex: number): number => Math.min(1000 * 2 ** attemptIndex, 10000);

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onSuccess: (_data, _variables, _context, mutation) => { if (shouldRefreshOperations(mutation.options.mutationKey)) refreshOperations(); },
    onError: (error) => {
    if (!(error instanceof TRPCClientError) || !error.data?.code) {
      toast.error(i18n.t("workspace.uncertainWrite"), { duration: 12000 });
    }
  } }),
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
      refetchOnWindowFocus: true,
      retry: shouldRetry,
      retryDelay: getRetryDelay,
      refetchOnMount: false,
      networkMode: "offlineFirst",
    },
    mutations: {
      ...mutationDefaults,
      retryDelay: getRetryDelay,
    },
  },
});

const refreshOperations = createOperationalRefresh(queryClient);
if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", event => {
  if (event.data?.type === "INSPECTION_SYNC_FINISHED") refreshOperations();
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, { ...(init ?? {}), credentials: "include" });
      },
    }),
  ],
});

applyManifestForRoute();
window.addEventListener("popstate", () => applyManifestForRoute());
// wouter uses pushState/replaceState; intercept for manifest swap
const _push = history.pushState.bind(history);
const _replace = history.replaceState.bind(history);
history.pushState = function (...args) { _push(...args); applyManifestForRoute(); } as typeof history.pushState;
history.replaceState = function (...args) { _replace(...args); applyManifestForRoute(); } as typeof history.replaceState;
registerServiceWorker();
setupInstallPrompt();

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
