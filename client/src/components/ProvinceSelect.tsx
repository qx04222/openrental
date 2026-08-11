import { CANADA_PROVINCES } from "@shared/rentalTypes";

interface ProvinceSelectProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  id?: string;
}

export default function ProvinceSelect({
  value,
  onChange,
  className = "w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm",
  placeholder = "Select province...",
  id,
}: ProvinceSelectProps) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
    >
      <option value="">{placeholder}</option>
      {CANADA_PROVINCES.map((p) => (
        <option key={p.code} value={p.code}>
          {p.code} – {p.name}
        </option>
      ))}
    </select>
  );
}
