import { lazy, Suspense, useEffect, useState } from "react";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { BrandingContext, defaultBranding, type BrandingConfig } from "@/config/branding";
import { Toaster } from "sonner";
import AdminRoute from "@/components/AdminRoute";
import Analytics from "@/components/Analytics";

// Lazy loaded pages
const AdminLogin = lazy(() => import("@/pages/admin/AdminLogin"));
const AdminDashboard = lazy(() => import("@/pages/admin/Dashboard"));
const RentalFleetPage = lazy(() => import("@/pages/admin/RentalFleet"));
const RentalManagement = lazy(() => import("@/pages/admin/RentalManagement"));
const DispatchPage = lazy(() => import("@/pages/admin/Dispatch"));
const InspectionsPage = lazy(() => import("@/pages/admin/Inspections"));
const SiteSettingsPage = lazy(() => import("@/pages/admin/SiteSettings"));
const CustomersPage = lazy(() => import("@/pages/admin/Customers"));
const CustomerDetailPage = lazy(() => import("@/pages/admin/CustomerDetail"));
const CustomerClassificationPage = lazy(() => import("@/pages/admin/CustomerClassification"));
const UsersPage = lazy(() => import("@/pages/admin/Users"));
const WarehousesPage = lazy(() => import("@/pages/admin/Warehouses"));
const RentalSettingsPage = lazy(() => import("@/pages/admin/RentalSettings"));
const ReportsPage = lazy(() => import("@/pages/admin/Reports"));
const UtilizationPage = lazy(() => import("@/pages/admin/Reports/Utilization"));
const AuditLogPage = lazy(() => import("@/pages/admin/AuditLog"));
const NotificationSettingsPage = lazy(() => import("@/pages/admin/NotificationSettings"));
const RecycleBin = lazy(() => import("@/pages/admin/RecycleBin"));
const SystemSettingsPage = lazy(() => import("@/pages/admin/SystemSettings"));
const FleetInspectionHistory = lazy(() => import("@/pages/admin/FleetInspectionHistory"));
const InvoicesPage = lazy(() => import("@/pages/admin/Invoices"));
const CustomerCreditPage = lazy(() => import("@/pages/admin/CustomerCredit"));
const CatalogSyncPage = lazy(() => import("@/pages/admin/CatalogSync"));
const ProjectsPage = lazy(() => import("@/pages/admin/Projects"));
const PromotionsPage = lazy(() => import("@/pages/admin/Promotions"));
const CategoryPricingPage = lazy(() => import("@/pages/admin/CategoryPricing"));
const CheckoutPage = lazy(() => import("@/pages/Checkout"));
const CollectionsPage = lazy(() => import("@/pages/admin/Collections"));
const QuotationsPage = lazy(() => import("@/pages/admin/Quotations"));
const WorkOrdersPage = lazy(() => import("@/pages/admin/WorkOrders"));
const DamageClaimsPage = lazy(() => import("@/pages/admin/DamageClaims"));
const ExtensionRequestsPage = lazy(() => import("@/pages/admin/ExtensionRequests"));
const RolePermissionsPage = lazy(() => import("@/pages/admin/RolePermissions"));
const CategoryManagementPage = lazy(() => import("@/pages/admin/CategoryManagement"));
const PDFTemplateSettingsPage = lazy(() => import("@/pages/admin/PDFTemplateSettings"));
const UserActivityPage = lazy(() => import("@/pages/admin/UserActivity"));
const DriversPage = lazy(() => import("@/pages/admin/Drivers"));
const FeatureFlagsPage = lazy(() => import("@/pages/admin/FeatureFlags"));

// Public / Customer pages
const RentalRequest = lazy(() => import("@/pages/RentalRequest"));
const RentalStatus = lazy(() => import("@/pages/RentalStatus"));


// Customer portal pages
const PortalLogin = lazy(() => import("@/pages/portal/PortalLogin"));
const PortalDashboard = lazy(() => import("@/pages/portal/PortalDashboard"));
const PortalOrders = lazy(() => import("@/pages/portal/PortalOrders"));
const PortalInvoices = lazy(() => import("@/pages/portal/PortalInvoices"));
const PortalDeposits = lazy(() => import("@/pages/portal/PortalDeposits"));
const PortalSign = lazy(() => import("@/pages/portal/PortalSign"));
const PortalOrderDetail = lazy(() => import("@/pages/portal/PortalOrderDetail"));

// Field staff pages
const FieldAccess = lazy(() => import("@/pages/FieldAccess"));
const FieldDashboard = lazy(() => import("@/pages/FieldDashboard"));
const FieldInspection = lazy(() => import("@/pages/FieldInspection"));
const StaffInspection = lazy(() => import("@/pages/StaffInspection"));
const FieldDeliveries = lazy(() => import("@/pages/FieldDeliveries"));
const DriverDeliveryConfirm = lazy(() => import("@/pages/DriverDeliveryConfirm"));

function Loading() {
  const { t } = useTranslation("common");
  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50">
      <div className="text-gray-900 text-lg">{t("loading")}</div>
    </div>
  );
}

function NotFound() {
  const { t } = useTranslation("common");
  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">404</h1>
        <p className="text-gray-500">{t("pageNotFound")}</p>
      </div>
    </div>
  );
}

function AdminPage({ component: Component }: { component: React.ComponentType }) {
  return (
    <AdminRoute>
      <Component />
    </AdminRoute>
  );
}

// Customer-facing surfaces get the OpenRental standalone-site brand theme
// (graphite + red). Staff/admin/field keep the existing app theme. Phase B
// (separate domain) layers hard isolation on top; this is purely visual.
const PUBLIC_PREFIXES = [
  "/rental-request", "/rental-status", "/checkout", "/portal",
];
function isPublicSurface(path: string): boolean {
  return path === "/" || PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p));
}

export default function App() {
  const [branding, setBranding] = useState<BrandingConfig>(defaultBranding);
  const [location] = useLocation();

  // Tag the document so CSS can scope the public brand theme to customer pages
  // only — see [data-surface="public"] in index.css.
  useEffect(() => {
    document.documentElement.dataset.surface = isPublicSurface(location) ? "public" : "admin";
  }, [location]);

  const { data: settings } = trpc.siteSettings.getAll.useQuery(undefined, {
    staleTime: 10 * 60 * 1000,
  });

  useEffect(() => {
    if (settings) {
      setBranding((prev) => ({
        ...prev,
        companyName: settings.company_name || prev.companyName,
        tagline: settings.tagline || prev.tagline,
        logoUrl: settings.logo_url || prev.logoUrl,
        primaryColor: settings.primary_color || prev.primaryColor,
        accentColor: settings.accent_color || prev.accentColor,
        contactEmail: settings.contact_email || prev.contactEmail,
        contactPhone: settings.contact_phone || prev.contactPhone,
        salesEmail: settings.sales_email || prev.salesEmail,
        salesPhone: settings.sales_phone || prev.salesPhone,
        address: settings.address || prev.address,
        domain: settings.domain || prev.domain,
      }));
    }
  }, [settings]);

  return (
    <BrandingContext.Provider value={branding}>
      {/* GA4 page-view tracking — inert unless VITE_GA4_ID is set; public pages only */}
      <Analytics path={location} enabled={isPublicSurface(location)} />
      <Suspense fallback={<Loading />}>
        <Switch>
          {/* Public / Customer.
              There is no marketing homepage: this is an operations system, so
              "/" goes straight to the admin console. Self-hosters who want a
              public storefront can add one — the customer request/status/portal
              flow below is the API surface it would sit on. */}
          <Route path="/"><Redirect to="/admin" /></Route>
          <Route path="/rental-request/:fleetId" component={RentalRequest} />
          <Route path="/rental-status" component={RentalStatus} />
          <Route path="/checkout" component={CheckoutPage} />

          {/* Customer Portal */}
          <Route path="/portal/login" component={PortalLogin} />
          <Route path="/portal/orders" component={PortalOrders} />
          <Route path="/portal/invoices" component={PortalInvoices} />
          <Route path="/portal/deposits" component={PortalDeposits} />
          <Route path="/portal/sign/:rentalId" component={PortalSign} />
          <Route path="/portal/orders/:id" component={PortalOrderDetail} />
          <Route path="/portal" component={PortalDashboard} />

          {/* Field Staff */}
          <Route path="/field-access" component={FieldAccess} />
          <Route path="/field-dashboard" component={FieldDashboard} />
          <Route path="/field-inspection" component={FieldInspection} />
          <Route path="/field-deliveries" component={FieldDeliveries} />
          <Route path="/inspect/:token" component={StaffInspection} />
          <Route path="/driver/confirm/:token" component={DriverDeliveryConfirm} />

          {/* Admin (login is public, everything else is protected) */}
          <Route path="/admin/login" component={AdminLogin} />
          <Route path="/admin">{() => <AdminPage component={AdminDashboard} />}</Route>
          <Route path="/admin/rental-fleet/:id/inspections">{() => <AdminPage component={FleetInspectionHistory} />}</Route>
          <Route path="/admin/rental-fleet">{() => <AdminPage component={RentalFleetPage} />}</Route>
          <Route path="/admin/rental-management">{() => <AdminPage component={RentalManagement} />}</Route>
          <Route path="/admin/dispatch">{() => <AdminPage component={DispatchPage} />}</Route>
          <Route path="/admin/inspections">{() => <AdminPage component={InspectionsPage} />}</Route>
          <Route path="/admin/site-settings">{() => <AdminPage component={SiteSettingsPage} />}</Route>
          <Route path="/admin/customers/:id">{() => <AdminPage component={CustomerDetailPage} />}</Route>
          <Route path="/admin/customers">{() => <AdminPage component={CustomersPage} />}</Route>
          <Route path="/admin/customer-classification">{() => <AdminPage component={CustomerClassificationPage} />}</Route>
          <Route path="/admin/users">{() => <AdminPage component={UsersPage} />}</Route>
          <Route path="/admin/warehouses">{() => <AdminPage component={WarehousesPage} />}</Route>
          <Route path="/admin/rental-settings">{() => <AdminPage component={RentalSettingsPage} />}</Route>
          <Route path="/admin/reports/utilization">{() => <AdminPage component={UtilizationPage} />}</Route>
          <Route path="/admin/reports">{() => <AdminPage component={ReportsPage} />}</Route>
          <Route path="/admin/audit-log">{() => <AdminPage component={AuditLogPage} />}</Route>
          <Route path="/admin/notifications">{() => <AdminPage component={NotificationSettingsPage} />}</Route>
          <Route path="/admin/invoices">{() => <AdminPage component={InvoicesPage} />}</Route>
          <Route path="/admin/customer-credit">{() => <AdminPage component={CustomerCreditPage} />}</Route>
          <Route path="/admin/catalog-sync">{() => <AdminPage component={CatalogSyncPage} />}</Route>
          <Route path="/admin/projects">{() => <AdminPage component={ProjectsPage} />}</Route>
          <Route path="/admin/promotions">{() => <AdminPage component={PromotionsPage} />}</Route>
          <Route path="/admin/category-pricing">{() => <AdminPage component={CategoryPricingPage} />}</Route>
          <Route path="/admin/collections">{() => <AdminPage component={CollectionsPage} />}</Route>
          <Route path="/admin/quotations">{() => <AdminPage component={QuotationsPage} />}</Route>
          <Route path="/admin/work-orders">{() => <AdminPage component={WorkOrdersPage} />}</Route>
          <Route path="/admin/damage-claims">{() => <AdminPage component={DamageClaimsPage} />}</Route>
          <Route path="/admin/extension-requests">{() => <AdminPage component={ExtensionRequestsPage} />}</Route>
          <Route path="/admin/categories">{() => <AdminPage component={CategoryManagementPage} />}</Route>
<Route path="/admin/role-permissions">{() => <AdminPage component={RolePermissionsPage} />}</Route>
          <Route path="/admin/user-activity">{() => <AdminPage component={UserActivityPage} />}</Route>
          <Route path="/admin/pdf-templates">{() => <AdminPage component={PDFTemplateSettingsPage} />}</Route>
          <Route path="/admin/drivers">{() => <AdminPage component={DriversPage} />}</Route>
          <Route path="/admin/recycle-bin">{() => <AdminPage component={RecycleBin} />}</Route>
          <Route path="/admin/system-settings">{() => <AdminPage component={SystemSettingsPage} />}</Route>
          <Route path="/admin/settings/feature-flags">{() => <AdminPage component={FeatureFlagsPage} />}</Route>

          {/* 404 */}
          <Route component={NotFound} />
        </Switch>
      </Suspense>
      <Toaster position="top-right" richColors />
    </BrandingContext.Provider>
  );
}
