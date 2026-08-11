import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react";

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const isZh = i18n.language?.startsWith("zh");

  const toggle = () => {
    i18n.changeLanguage(isZh ? "en" : "zh");
  };

  return (
    <button
      onClick={toggle}
      className="flex items-center gap-1.5 px-2 py-1 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition"
      aria-label="Switch language"
    >
      <Globe size={16} />
      <span className="font-medium">{isZh ? "EN" : "中"}</span>
    </button>
  );
}
