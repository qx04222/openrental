export type GlobalSearchResultKind = "customer" | "fleet" | "rental" | "invoice" | "project";

export function getGlobalSearchPath(kind: GlobalSearchResultKind, id: number): string {
  switch (kind) {
    case "customer": return `/admin/customers/${id}`;
    case "fleet": return `/admin/rental-fleet?fleetId=${id}`;
    case "rental": return `/admin/rental-management?rentalId=${id}`;
    case "invoice": return `/admin/invoices?invoiceId=${id}`;
    case "project": return `/admin/projects?projectId=${id}`;
  }
}

export function getPositiveSearchParam(search: string, key: string): number | null {
  const raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get(key);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
