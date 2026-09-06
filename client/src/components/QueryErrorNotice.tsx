import { useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { TRPCClientError } from "@trpc/client";

/** Keep list screens honest even when a page still renders data ?? []. */
export default function QueryErrorNotice() {
  const client = useQueryClient();
  const cache = client.getQueryCache();
  const { t } = useTranslation("common");
  const failed = () => cache.findAll({ type: "active" }).filter(query => {
    if (query.state.status !== "error") return false;
    const error = query.state.error;
    return !(error instanceof TRPCClientError && ["FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND"].includes(error.data?.code));
  });
  const errors = useSyncExternalStore(
    callback => cache.subscribe(callback),
    () => failed().map(query => query.queryHash).sort().join("|"),
    () => "",
  );
  if (!errors) return null;
  return <div className="query-error-notice" role="status">
    <AlertCircle size={20} /><p>{t("workspace.partialFailure")}</p>
    <button onClick={() => void client.refetchQueries({ type: "active", predicate: query => query.state.status === "error" })}>{t("workspace.retry")}</button>
  </div>;
}
