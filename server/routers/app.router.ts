import { router, mergeRouters } from "../_core/trpc";
import { fieldAuthRouter } from "./fieldAuth";
import { rentalFleetRouter } from "./rentalFleet.router";
import { rentalRequestsRouter } from "./rentalRequests.router";
import { rentalPrepaymentsRouter } from "./rentalPrepayments.router";
import { catalogSyncRouter } from "./catalogSync.router";
import { projectsRouter } from "./projects.router";
import { paymentsRouter } from "./payments.router";
import { referralLedgerRouter } from "./referralLedger.router";
import { promotionsRouter } from "./promotions.router";
import { customerPricingRouter } from "./customerPricing.router";
import { customerCreditRouter } from "./customerCredit.router";
import { collectionsRouter } from "./collections.router";
import { rentalChargesRouter } from "./rentalCharges.router";
import { inspectionsRouter } from "./inspections.router";
import { dispatchRouter } from "./dispatch.router";
import { siteSettingsRouter } from "./siteSettings.router";
import { customersRouter } from "./customers.router";
import { warehousesRouter } from "./warehouses.router";
import { usersRouter } from "./users.router";
import { shippingRouter } from "./shipping.router";
import { rentalSettingsRouter } from "./rentalSettings.router";
import { availabilityRouter } from "./availability.router";
import { auditLogRouter } from "./auditLog.router";
import { reportsRouter } from "./reports.router";
import { notificationsRouter } from "./notifications.router";
import { recycleBinRouter } from "./recycleBin.router";
import { dashboardRouter } from "./dashboard.router";
import { searchRouter } from "./search.router";
import { invoicesRouter } from "./invoices.router";
import { downtimeRouter } from "./downtime.router";
import { workOrdersRouter } from "./workOrders.router";
import { driversRouter } from "./drivers.router";
import { damageClaimsRouter } from "./damageClaims.router";
import { depositRulesRouter } from "./depositRules.router";
import { equipmentModelsRouter } from "./equipmentModels.router";
import { equipmentCategoriesRouter } from "./equipmentCategories.router";
import { attachmentCompatibilityRouter } from "./attachmentCompatibility.router";
import { customerAuthRouter } from "./customerAuth";
import { customerPortalRouter } from "./customerPortal";
import { extensionRequestsRouter } from "./extensionRequests.router";
import { contractTemplatesRouter } from "./contractTemplates.router";
import { permissionsRouter } from "./permissions.router";
import { rolePermissionsRouter } from "./rolePermissions.router";
import { quotationsRouter } from "./quotations.router";
import { loginSessionsRouter } from "./loginSessions.router";
import { featureFlagsRouter } from "./featureFlags.router";
import { signatureEvidenceRouter } from "./signatureEvidence.router";
import { rentalAssetProgressRouter } from "./rentalAssetProgress.router";
import { rollingRentalsRouter } from "./rollingRentals.router";

const baseRouter = router({
  dashboard: dashboardRouter,
  fieldAuth: fieldAuthRouter,
  rentalFleet: rentalFleetRouter,
  rentals: rentalRequestsRouter,
  rentalPrepayments: rentalPrepaymentsRouter,
  catalogSync: catalogSyncRouter,
  projects: projectsRouter,
  payments: paymentsRouter,
  referralLedger: referralLedgerRouter,
  promotions: promotionsRouter,
  customerPricing: customerPricingRouter,
  customerCredit: customerCreditRouter,
  collections: collectionsRouter,
  rentalCharges: rentalChargesRouter,
  inspections: inspectionsRouter,
  dispatch: dispatchRouter,
  siteSettings: siteSettingsRouter,
  customers: customersRouter,
  warehouses: warehousesRouter,
  users: usersRouter,
  shipping: shippingRouter,
  rentalSettings: rentalSettingsRouter,
  availability: availabilityRouter,
  auditLog: auditLogRouter,
  reports: reportsRouter,
  notifications: notificationsRouter,
  recycleBin: recycleBinRouter,
  search: searchRouter,
  invoices: invoicesRouter,
  downtime: downtimeRouter,
  workOrders: workOrdersRouter,
  drivers: driversRouter,
  damageClaims: damageClaimsRouter,
  depositRules: depositRulesRouter,
  equipmentModels: equipmentModelsRouter,
  equipmentCategories: equipmentCategoriesRouter,
  attachmentCompatibility: attachmentCompatibilityRouter,
  customerAuth: customerAuthRouter,
  customerPortal: customerPortalRouter,
  extensionRequests: extensionRequestsRouter,
  contractTemplates: contractTemplatesRouter,
  permissions: permissionsRouter,
  rolePermissions: rolePermissionsRouter,
  quotations: quotationsRouter,
  loginSessions: loginSessionsRouter,
  featureFlags: featureFlagsRouter,
  signatureEvidence: signatureEvidenceRouter,
  rentalAssetProgress: rentalAssetProgressRouter,
  rollingRentals: rollingRentalsRouter,
});

export const appRouter = mergeRouters(baseRouter);
export type AppRouter = typeof appRouter;
