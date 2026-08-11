export const COOKIE_NAME = "openrental_session_id";
export const ADMIN_COOKIE_NAME = "openrental_admin_session";
export const FIELD_COOKIE_NAME = "openrental_field_session";
export const CUSTOMER_COOKIE_NAME = "customer_session";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;

export const BRAND_CONTACT = {
  companyName: "OpenRental",
  tagline: "Equipment rental, run properly",
  rentalEmail: "rentals@openrental.example",
  rentalPhone: "+1 555-010-0100",
  salesEmail: "sales@openrental.example",
  salesPhone: "+1 555-010-0200",
  address: "100 Example Ave, Toronto, ON M5V 0A1",
  domain: "openrental.example",
};

export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = "Please login (10001)";
export const NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";
