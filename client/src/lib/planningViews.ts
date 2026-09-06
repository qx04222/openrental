export interface PlanningFilters { search: string; category: string; location: string; status: "all" | "available" | "attention"; days: 7 | 14 | 28 }
export interface PlanningView { id: string; name: string; filters: PlanningFilters }
export const defaultPlanningFilters: PlanningFilters = { search: "", category: "", location: "", status: "all", days: 14 };
export function readPlanningFilters(value: unknown): PlanningFilters {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const text = (key: string) => typeof v[key] === "string" ? (v[key] as string).slice(0, 100) : "";
  return { search: text("search"), category: text("category"), location: text("location"), status: v.status === "available" || v.status === "attention" ? v.status : "all", days: v.days === 7 || v.days === 28 ? v.days : 14 };
}
export function planningStorageKey(identity: string): string { return `openrental:planning:v2:${encodeURIComponent(identity)}`; }
export function decodePlanningViews(raw: string | null): PlanningView[] {
  try {
    const values: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(values)) return [];
    return values.filter(v => v && typeof v.id === "string" && typeof v.name === "string" && v.name.trim()).slice(0, 8).map(v => ({ id: v.id.slice(0, 100), name: v.name.slice(0, 40), filters: readPlanningFilters(v.filters) }));
  } catch { return []; }
}
