/**
 * Lightweight input sanitization for user-facing text fields.
 * Strips <script> tags and event handler attributes to prevent stored XSS.
 * Does NOT strip all HTML — preserves legitimate characters like < > in text.
 */

/** Remove <script>...</script> tags and on* event attributes */
export function stripScriptTags(input: string): string {
  return input
    // Remove <script>...</script> (including multiline)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    // Remove standalone <script> or </script> tags
    .replace(/<\/?script[^>]*>/gi, "")
    // Remove on* event handlers in any remaining tags (e.g. onerror, onclick)
    .replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

/** Sanitize all string values in a flat object */
export function sanitizeStrings<T extends Record<string, unknown>>(obj: T): T {
  const result = { ...obj };
  for (const key of Object.keys(result)) {
    const val = result[key];
    if (typeof val === "string") {
      (result as Record<string, unknown>)[key] = stripScriptTags(val);
    }
  }
  return result;
}
