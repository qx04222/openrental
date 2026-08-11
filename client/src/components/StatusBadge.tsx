/**
 * StatusBadge — M3-styled status badge with dot indicator
 *
 * Usage:
 *   <StatusBadge colorClass="bg-emerald-100 text-emerald-800" dotClass="bg-emerald-600">ACTIVE</StatusBadge>
 *
 * Or with a color map:
 *   <StatusBadge colorClass={rentalStatusColors[status]} dotClass={statusDotColors[status]}>{status}</StatusBadge>
 */

interface StatusBadgeProps {
  colorClass: string;
  dotClass?: string;
  children: React.ReactNode;
  className?: string;
}

// Derive dot color from the text color class (e.g. "bg-emerald-100 text-emerald-800" → "bg-emerald-600")
function deriveDotClass(colorClass: string): string {
  const match = colorClass.match(/text-(\w+)-(\d+)/);
  if (match) {
    const color = match[1];
    return `bg-${color}-600`;
  }
  return "bg-slate-400";
}

export default function StatusBadge({ colorClass, dotClass, children, className = "" }: StatusBadgeProps) {
  const dot = dotClass || deriveDotClass(colorClass);

  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${colorClass} ${className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {children}
    </span>
  );
}
