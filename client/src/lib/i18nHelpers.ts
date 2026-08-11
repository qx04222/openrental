export type RuntimeTranslator = (key: never, options?: never) => unknown;

export function translateDynamic(
  t: RuntimeTranslator,
  key: string,
  options?: Record<string, unknown>,
): string {
  return String(t(key as never, options as never));
}

export function tDeliveryMethod(t: RuntimeTranslator, key: string) {
  return {
    label: translateDynamic(t, `delivery.${key}.label`, { ns: "rental" }),
    description: translateDynamic(t, `delivery.${key}.description`, { ns: "rental" }),
  };
}

export function tInsurance(t: RuntimeTranslator, key: string) {
  return {
    label: translateDynamic(t, `insurance.${key}.label`, { ns: "rental" }),
    description: translateDynamic(t, `insurance.${key}.description`, { ns: "rental" }),
  };
}
