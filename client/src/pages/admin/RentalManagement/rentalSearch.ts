type SearchDate = string | Date | null | undefined;

export interface RentalSearchRow {
  rental_requests: {
    id: number;
    rentalNumber?: string | null;
    financialOrderNumber?: string | null;
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    customerCompany?: string | null;
    equipmentDescription?: string | null;
    status?: string | null;
    startDate?: SearchDate;
    endDate?: SearchDate;
  };
  rental_fleet?: {
    brand?: string | null;
    model?: string | null;
    serialNumber?: string | null;
    assetNumber?: string | null;
    category?: string | null;
  } | null;
}

export interface RentalSearchTextOptions {
  statusLabel?: string;
  formatDate?: (value: SearchDate) => string;
}

export function buildRentalSearchText(
  row: RentalSearchRow,
  options: RentalSearchTextOptions = {},
): string {
  const rental = row.rental_requests;
  const fleet = row.rental_fleet;
  const formatDate = options.formatDate ?? ((value: SearchDate) => value == null ? "" : String(value));

  return [
    rental.id,
    `#${rental.id}`,
    rental.rentalNumber,
    rental.financialOrderNumber,
    rental.customerName,
    rental.customerEmail,
    rental.customerPhone,
    rental.customerCompany,
    rental.equipmentDescription,
    fleet?.brand,
    fleet?.model,
    fleet?.serialNumber,
    fleet?.assetNumber,
    fleet?.category,
    rental.status,
    options.statusLabel,
    formatDate(rental.startDate),
    formatDate(rental.endDate),
  ].filter((value) => value != null && value !== "").join(" ");
}
