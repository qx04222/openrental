import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { ArrowUpRight, ListOrdered } from "lucide-react";
import { prioritizeOperations, type InsightQueue } from "@shared/operationalIntelligence";

export default function OperationsSuggestions({ queue }: { queue: InsightQueue }) {
  const { t } = useTranslation("dashboard");
  const suggestions = prioritizeOperations(queue);
  if (!suggestions.length) return null;
  return <section className="desk-suggestions" aria-labelledby="suggestions-title">
    <div className="desk-suggestions-heading"><h2 id="suggestions-title"><ListOrdered size={18} />{t("suggestions.title")}</h2><p>{t("suggestions.subtitle")}</p></div>
    <div className="desk-suggestion-grid">{suggestions.map((item, index) => <Link key={item.key} href={item.href} className="desk-suggestion">
      <div><span className="suggestion-number">0{index + 1}</span><span className={`suggestion-urgency suggestion-${item.urgency}`}>{t(`suggestions.${item.urgency}`)}</span><ArrowUpRight size={16} /></div>
      <h3>{t(`desk.kinds.${item.kind}`)} · {item.ref}</h3><p>{t(`suggestions.reason.${item.kind}`)}</p>
      <small>{t("suggestions.evidence", { age: item.ageDays, target: item.slaDays })}</small>
    </Link>)}</div>
  </section>;
}
