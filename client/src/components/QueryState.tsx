import { AlertCircle, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function QueryState({ loading, onRetry }: { loading: boolean; onRetry: () => void }) {
  const { t } = useTranslation("common");
  return <div className="query-state" role={loading ? "status" : "alert"} aria-busy={loading}>
    {loading ? <RefreshCw className="animate-spin" size={24} /> : <AlertCircle size={24} />}
    <p>{t(loading ? "workspace.loading" : "workspace.failed")}</p>
    {!loading && <button className="btn-secondary" onClick={onRetry}>{t("workspace.retry")}</button>}
  </div>;
}
