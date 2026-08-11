/**
 * FuelGauge — mobile-friendly horizontal fuel gauge with 9 clickable levels.
 * Stores integer 0-100 matching the DB column inspections.fuelLevel.
 */

const FUEL_LEVELS = [
  { value: 0, label: "E" },
  { value: 13, label: "1/8" },
  { value: 25, label: "1/4" },
  { value: 38, label: "3/8" },
  { value: 50, label: "1/2" },
  { value: 63, label: "5/8" },
  { value: 75, label: "3/4" },
  { value: 88, label: "7/8" },
  { value: 100, label: "F" },
] as const;

/** Returns a human-readable label for a numeric fuel value (e.g. 50 → "1/2 (50%)") */
export function fuelGaugeLabel(value: number): string {
  const match = FUEL_LEVELS.find((l) => l.value === value);
  if (match) return `${match.label} (${value}%)`;
  return `${value}%`;
}

function segmentColor(index: number, active: boolean): string {
  if (!active) return "bg-slate-200";
  // 0=red, 1-2=amber/orange, 3+=green gradient
  if (index === 0) return "bg-red-500";
  if (index <= 2) return "bg-amber-500";
  if (index <= 4) return "bg-yellow-400";
  if (index <= 6) return "bg-lime-500";
  return "bg-green-500";
}

interface FuelGaugeProps {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

export function FuelGauge({ value, onChange, disabled }: FuelGaugeProps) {
  const activeIndex = FUEL_LEVELS.findIndex((l) => l.value === value);

  return (
    <div className="w-full">
      {/* Bar */}
      <div className="flex items-stretch gap-0.5 w-full" style={{ minHeight: 44 }}>
        {FUEL_LEVELS.map((level, i) => {
          const isActive = i <= activeIndex;
          const isSelected = level.value === value;
          return (
            <button
              key={level.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(level.value)}
              className={[
                "flex-1 flex items-center justify-center text-xs font-semibold transition-colors",
                "rounded-sm select-none",
                segmentColor(i, isActive),
                isActive ? "text-white" : "text-slate-400",
                isSelected ? "ring-2 ring-offset-1 ring-gray-800" : "",
                disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer active:scale-95",
              ].join(" ")}
              aria-label={`${level.label} (${level.value}%)`}
            >
              {level.label}
            </button>
          );
        })}
      </div>

      {/* Legend row */}
      <div className="flex justify-between mt-1 px-0.5">
        <span className="text-[10px] text-red-600 font-medium">E</span>
        <span className="text-xs text-slate-600 font-medium">{value}%</span>
        <span className="text-[10px] text-green-600 font-medium">F</span>
      </div>
    </div>
  );
}
