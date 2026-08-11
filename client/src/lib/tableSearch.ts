export interface TableSearchColumn {
  key: string;
  searchable?: boolean;
}

function getNestedValue(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, part) => {
    if (value == null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[part];
  }, obj);
}

export function matchesTableSearch<T>(
  row: T,
  columns: TableSearchColumn[],
  query: string,
  getSearchText?: (row: T) => string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  if (getSearchText) {
    return getSearchText(row).toLowerCase().includes(normalizedQuery);
  }

  return columns.some((column) => {
    if (column.searchable === false) return false;
    const value = getNestedValue(row, column.key);
    return value != null && String(value).toLowerCase().includes(normalizedQuery);
  });
}
