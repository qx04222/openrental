/** New installations start with usability features. Financial automation stays opt-in. */
export const DEFAULT_FEATURE_FLAGS = [
  "form_memory", "confirm_dialog", "global_search", "batch_operations",
  "today_dashboard", "customer_360", "utilization_dashboard", "audit_log_search",
  "rental_duplicate", "conflict_warning", "signature_evidence",
].map(key => ({ key, enabled: true }));
