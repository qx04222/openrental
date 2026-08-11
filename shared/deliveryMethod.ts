export const DELIVERY_METHODS = {
  pickup: {
    label: "Customer Pickup",
    description: "Pick up from warehouse (free)",
    hasDeliveryAddress: false,
    hasFreight: false,
    trips: 0,
  },
  delivery: {
    label: "One-Way Delivery",
    description: "We deliver to your site (one trip)",
    hasDeliveryAddress: true,
    hasFreight: true,
    trips: 1,
  },
  delivery_and_return: {
    label: "Delivery & Return",
    description: "We deliver and pick up (two trips)",
    hasDeliveryAddress: true,
    hasFreight: true,
    trips: 2,
  },
} as const;

export type DeliveryMethod = keyof typeof DELIVERY_METHODS;
