import { trpc } from "@/lib/trpc";
import { useTranslation } from "react-i18next";

interface CategorySelectProps {
  value: string;
  onChange: (value: string) => void;
  /** Narrow the list to machine or attachment categories; omitted = all. */
  kind?: "machine" | "attachment";
  disabled?: boolean;
  className?: string;
}

export default function CategorySelect({ value, onChange, kind, disabled, className }: CategorySelectProps) {
  const { t } = useTranslation("fleet");
  const { data: categories } = trpc.equipmentCategories.listActive.useQuery(kind ? { type: kind } : undefined);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={className || "w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-1 focus:ring-[var(--primary)]/50 focus:border-[var(--primary)] disabled:bg-slate-100 disabled:text-slate-500"}
    >
      <option value="">{t("categoryManagement.selectCategory")}</option>
      {categories?.map((cat) => (
        <option key={cat.id} value={cat.name}>
          {cat.name}
        </option>
      ))}
    </select>
  );
}
