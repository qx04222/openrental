import type { RouterOutputs } from "@/lib/trpc";
import { DEFAULT_TIMEZONE } from "@/lib/dateUtils";

export type ExtensionRequestListItem = RouterOutputs["extensionRequests"]["list"][number];

export function toExtensionRequestRow(item: ExtensionRequestListItem) {
  const { extension, customer, rental } = item;
  const rentalId = extension.rentalRequestId ?? 0;

  return {
    id: extension.id,
    customerName: customer?.name ?? "-",
    rentalId,
    rentalNumber: rental?.rentalNumber ?? `#${rentalId}`,
    requestedDate: extension.requestedEndDate.toLocaleDateString("en-CA", {
      timeZone: DEFAULT_TIMEZONE,
    }),
    rawReason: extension.reason ?? "",
    status: extension.status,
  };
}
