// Unified status badge colors — refined for M3 design system
// Uses softer tones with bolder text for better visual hierarchy

// Rental request status
export const rentalStatusColors: Record<string, string> = {
  pending:   "bg-amber-100 text-amber-800",
  approved:  "bg-blue-100 text-blue-800",
  rejected:  "bg-red-100 text-red-800",
  active:    "bg-emerald-100 text-emerald-800",
  completed: "bg-slate-100 text-slate-500",
  cancelled: "bg-red-100 text-red-800",
  overdue:   "bg-orange-100 text-orange-800",
};

// Dispatch order status
export const dispatchStatusColors: Record<string, string> = {
  pending:    "bg-amber-100 text-amber-800",
  assigned:   "bg-blue-100 text-blue-800",
  in_transit: "bg-purple-100 text-purple-800",
  delivered:  "bg-emerald-100 text-emerald-800",
  completed:  "bg-slate-100 text-slate-500",
  cancelled:  "bg-red-100 text-red-800",
};

// Fleet asset status
export const fleetStatusColors: Record<string, string> = {
  available:   "bg-emerald-100 text-emerald-800",
  rented:      "bg-blue-100 text-blue-800",
  maintenance: "bg-amber-100 text-amber-800",
  retired:     "bg-slate-100 text-slate-500",
};

// User roles
export const roleColors: Record<string, string> = {
  super_admin: "bg-red-200 text-red-800",
  admin:       "bg-red-100 text-red-800",
  accountant:  "bg-emerald-100 text-emerald-800",
  field_staff: "bg-blue-100 text-blue-800",
  user:        "bg-slate-100 text-slate-500",
};

// Audit log actions
export const auditActionColors: Record<string, string> = {
  create:           "bg-emerald-100 text-emerald-800",
  update:           "bg-blue-100 text-blue-800",
  delete:           "bg-red-100 text-red-800",
  status_change:    "bg-amber-100 text-amber-800",
  restore:          "bg-cyan-100 text-cyan-800",
  permanent_delete: "bg-red-200 text-red-800",
  empty_recycle_bin: "bg-red-200 text-red-800",
};

// Audit log entity types
export const auditEntityColors: Record<string, string> = {
  rental:    "bg-purple-100 text-purple-800",
  fleet:     "bg-indigo-100 text-indigo-800",
  user:      "bg-pink-100 text-pink-800",
  customer:  "bg-cyan-100 text-cyan-800",
  dispatch:  "bg-orange-100 text-orange-800",
  warehouse: "bg-teal-100 text-teal-800",
  settings:   "bg-slate-100 text-slate-500",
  inspection: "bg-lime-100 text-lime-800",
  invoice:    "bg-emerald-100 text-emerald-800",
  quotation:  "bg-amber-100 text-amber-800",
};

// Notification log status
export const notificationStatusColors: Record<string, string> = {
  sent:    "bg-emerald-100 text-emerald-800",
  failed:  "bg-red-100 text-red-800",
  pending: "bg-amber-100 text-amber-800",
};

// Catalog source type
export const catalogSourceColors: Record<string, string> = {
  industrial:  "bg-blue-100 text-blue-800",
  powersports: "bg-purple-100 text-purple-800",
  manual:      "bg-emerald-100 text-emerald-800",
};

// Inspection type badges
export const inspectionTypeBadges: Record<string, string> = {
  dispatch: "bg-blue-100 text-blue-800",
  return:   "bg-purple-100 text-purple-800",
  general:  "bg-slate-100 text-slate-500",
};

// Condition colors (text-only, no background)
export const conditionColors: Record<string, string> = {
  excellent: "text-emerald-700",
  good:      "text-blue-700",
  fair:      "text-amber-700",
  poor:      "text-red-700",
};

// Maintenance status colors (text-only)
export const maintStatusColors: Record<string, string> = {
  ok:       "text-emerald-700",
  due_soon: "text-amber-700",
  overdue:  "text-red-700",
};
