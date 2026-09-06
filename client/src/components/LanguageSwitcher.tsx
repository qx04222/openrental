import { useTranslation } from "react-i18next";
import { useState } from "react";
import { toast } from "sonner";
import { Globe } from "lucide-react";

export default function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const isZh = i18n.language?.startsWith("zh");

  const toggle = () => {
    if (loading) return;
    const target = isZh ? "en" : "zh";
    setLoading(true);
    i18n.loadLanguages(target, error => {
      if (error) { toast.error(t("workspace.languageFailed")); setLoading(false); return; }
      void i18n.changeLanguage(target).finally(() => setLoading(false));
    });
  };

  return (
    <button
      onClick={toggle}
      disabled={loading}
      aria-busy={loading}
      className="flex items-center gap-1.5 px-2 py-1 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition"
      aria-label="Switch language"
    >
      <Globe size={16} />
      <span className="font-medium">{isZh ? "EN" : "中"}</span>
    </button>
  );
}
