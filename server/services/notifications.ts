import { getDb, eq, and, sql, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import type { CreateEmailOptions } from "resend";

// ─── Config helpers ──────────────────────────────────────────
export async function getProviderConfig(provider: string): Promise<Record<string, string>> {
  const db = await getDb();
  if (!db) return {};

  const rows = await db
    .select()
    .from(schema.notificationSettings)
    .where(eq(schema.notificationSettings.provider, provider));

  const config: Record<string, string> = {};
  for (const row of rows) {
    config[row.configKey] = row.configValue;
  }
  return config;
}

// Check if a channel is globally enabled
async function isChannelEnabled(channel: "email" | "sms"): Promise<boolean> {
  const config = await getProviderConfig("global");
  const key = `${channel}_enabled`;
  return config[key] !== "false"; // defaults to true if not set
}

// Exposed so business-SMS senders (smsNotify) can honor the same global toggle.
export async function isSmsEnabled(): Promise<boolean> {
  return isChannelEnabled("sms");
}

// ─── Email (Resend) ──────────────────────────────────────────
export async function sendEmail(to: string, subject: string, html: string, event?: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Check global enable
    if (!(await isChannelEnabled("email"))) {
      return { success: false, error: "Email notifications are disabled" };
    }

    const config = await getProviderConfig("resend");
    const apiKey = config.api_key;
    if (!apiKey) throw new Error("Resend API key not configured");

    const fromEmail = config.from_email || "noreply@openrental.example";
    const fromName = config.from_name || "OpenRental";
    const replyTo = config.reply_to || undefined;

    const { Resend } = await import("resend");
    const resend = new Resend(apiKey);

    const emailPayload: { from: string; to: string; subject: string; html: string; replyTo?: string; bcc?: string } = {
      from: `${fromName} <${fromEmail}>`,
      to,
      subject,
      html: applyEmailSignature(html, config.signature || ""),
    };
    if (replyTo) emailPayload.replyTo = replyTo;

    // BCC admin if configured
    const bccAdmin = config.bcc_admin;
    if (bccAdmin) emailPayload.bcc = bccAdmin;

    await resend.emails.send(emailPayload);

    await logNotification("email", to, subject, event, "sent");
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[Notifications] Email send failed", { error: message, to });
    await logNotification("email", to, subject, event, "failed", message);
    return { success: false, error: message };
  }
}

function applyEmailSignature(html: string, signature: string): string {
  if (!signature) return html;
  return `${html}<br/><hr style="border:none;border-top:1px solid #eee;margin:20px 0"/><div style="color:#999;font-size:12px">${signature}</div>`;
}

// ─── SMS (Telnyx) ────────────────────────────────────────────
export async function sendSMS(to: string, body: string, event?: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Check global enable
    if (!(await isChannelEnabled("sms"))) {
      return { success: false, error: "SMS notifications are disabled" };
    }

    const config = await getProviderConfig("telnyx");
    const apiKey = config.api_key;
    const fromNumber = config.from_number;
    const profileId = config.messaging_profile_id || undefined;
    if (!apiKey || !fromNumber) throw new Error("Telnyx not fully configured");

    const Telnyx = (await import("telnyx")).default;
    const telnyx = new Telnyx({ apiKey });
    await telnyx.messages.send({
      from: fromNumber,
      to,
      text: body,
      ...(profileId ? { messaging_profile_id: profileId } : {}),
    });

    await logNotification("sms", to, undefined, event, "sent");
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[Notifications] SMS send failed", { error: message, to });
    await logNotification("sms", to, undefined, event, "failed", message);
    return { success: false, error: message };
  }
}

// ─── Test connection (verify API keys) ───────────────────────
export async function testEmailConnection(): Promise<{ success: boolean; error?: string }> {
  try {
    const config = await getProviderConfig("resend");
    const apiKey = config.api_key;
    if (!apiKey) return { success: false, error: "API key not configured" };

    const { Resend } = await import("resend");
    const resend = new Resend(apiKey);
    // Try to list domains — lightweight check that the API key works
    await resend.domains.list();
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function testSmsConnection(): Promise<{ success: boolean; error?: string }> {
  try {
    const config = await getProviderConfig("telnyx");
    const apiKey = config.api_key;
    if (!apiKey) return { success: false, error: "Telnyx API key not configured" };

    const Telnyx = (await import("telnyx")).default;
    const telnyx = new Telnyx({ apiKey });
    // List messaging profiles to verify API key works
    await telnyx.messagingProfiles.list({ "page[size]": 1 });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Stats ───────────────────────────────────────────────────
export async function getNotificationStats() {
  const db = await getDb();
  if (!db) return { totalSent: 0, totalFailed: 0, emailSent: 0, smsSent: 0, last24h: 0, last7d: 0 };

  const now = new Date();
  const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [stats] = await db.select({
    totalSent: sql<number>`count(*) filter (where ${schema.notificationLog.status} = 'sent')`.as("totalSent"),
    totalFailed: sql<number>`count(*) filter (where ${schema.notificationLog.status} = 'failed')`.as("totalFailed"),
    emailSent: sql<number>`count(*) filter (where ${schema.notificationLog.channel} = 'email' and ${schema.notificationLog.status} = 'sent')`.as("emailSent"),
    smsSent: sql<number>`count(*) filter (where ${schema.notificationLog.channel} = 'sms' and ${schema.notificationLog.status} = 'sent')`.as("smsSent"),
    // postgres.js cannot bind a JS Date into a raw sql`` fragment — it throws
    // ERR_INVALID_ARG_TYPE and takes the WHOLE stats query down, which the UI
    // then renders as six zeroes. Always hand raw fragments an ISO string.
    last24h: sql<number>`count(*) filter (where ${schema.notificationLog.createdAt} >= ${h24.toISOString()})`.as("last24h"),
    last7d: sql<number>`count(*) filter (where ${schema.notificationLog.createdAt} >= ${d7.toISOString()})`.as("last7d"),
  }).from(schema.notificationLog);

  return {
    totalSent: Number(stats?.totalSent ?? 0),
    totalFailed: Number(stats?.totalFailed ?? 0),
    emailSent: Number(stats?.emailSent ?? 0),
    smsSent: Number(stats?.smsSent ?? 0),
    last24h: Number(stats?.last24h ?? 0),
    last7d: Number(stats?.last7d ?? 0),
  };
}

// ─── Template rendering ──────────────────────────────────────
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
}

// ─── Log notification ────────────────────────────────────────
export async function logNotification(
  channel: string,
  recipient: string,
  subject?: string,
  event?: string,
  status: string = "sent",
  errorMessage?: string,
  relatedEntityType?: string,
  relatedEntityId?: number,
) {
  try {
    const db = await getDb();
    if (!db) return;

    await db.insert(schema.notificationLog).values({
      channel,
      recipient,
      subject: subject || null,
      event: event || null,
      status,
      errorMessage: errorMessage || null,
      relatedEntityType: relatedEntityType || null,
      relatedEntityId: relatedEntityId || null,
    });
  } catch (err) {
    logger.error("[Notifications] Failed to log notification", { error: err instanceof Error ? err.message : String(err) });
  }
}

// ─── Invoice Email (with PDF attachment) ─────────────────────
export async function sendInvoiceEmail(invoiceId: number): Promise<void> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Check if auto-send is enabled
    const settingsRows = await db.select().from(schema.rentalSettings);
    const settingsMap: Record<string, string> = {};
    for (const r of settingsRows) settingsMap[r.key] = r.value;
    if (settingsMap.invoice_auto_send === "false") {
      logger.info("[Notifications] Invoice auto-send disabled, skipping");
      return;
    }

    // Respect the global email toggle (notification_settings global.email_enabled)
    if (!(await isChannelEnabled("email"))) {
      logger.info("[Notifications] Email globally disabled, skipping invoice email");
      return;
    }

    // Fetch invoice + customer
    const [invoiceRow] = await db
      .select()
      .from(schema.invoices)
      .leftJoin(schema.customers, and(eq(schema.invoices.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
      .where(and(eq(schema.invoices.id, invoiceId), isNull(schema.invoices.deletedAt)))
      .limit(1);

    if (!invoiceRow) throw new Error(`Invoice #${invoiceId} not found`);

    const invoice = invoiceRow.invoices;
    const customer = invoiceRow.customers;

    if (!customer?.email) {
      logger.warn("[Notifications] No customer email for invoice", { invoiceId });
      return;
    }

    // Generate PDF if not already generated
    let pdfUrl = invoice.pdfUrl;
    if (!pdfUrl) {
      const { generateInvoicePDF } = await import("./invoicePDF");
      const result = await generateInvoicePDF(invoiceId);
      pdfUrl = result.url;
    }

    // Fetch PDF as buffer for attachment
    const pdfResponse = await fetch(pdfUrl);
    if (!pdfResponse.ok) throw new Error(`Failed to fetch PDF from ${pdfUrl}`);
    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());

    // Look for an invoice_created template
    const templates = await db
      .select()
      .from(schema.notificationTemplates)
      .where(and(
        eq(schema.notificationTemplates.event, "invoice_created"),
        eq(schema.notificationTemplates.isActive, true),
        eq(schema.notificationTemplates.channel, "email"),
      ))
      .limit(1);

    const variables: Record<string, string> = {
      customerName: customer.name,
      invoiceNumber: invoice.invoiceNumber,
      totalAmount: `$${Number(invoice.totalAmount).toFixed(2)}`,
      dueDate: invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString("en-CA") : "N/A",
    };

    let subject: string;
    let html: string;

    if (templates.length > 0) {
      subject = renderTemplate(templates[0].subject || "Invoice {{invoiceNumber}}", variables);
      html = renderTemplate(templates[0].body, variables);
    } else {
      subject = `Invoice ${invoice.invoiceNumber} from OpenRental`;
      html = `<p>Dear ${customer.name},</p>
<p>Please find attached your invoice <strong>${invoice.invoiceNumber}</strong>.</p>
<p><strong>Amount Due:</strong> $${Number(invoice.balanceDue).toFixed(2)}<br/>
<strong>Due Date:</strong> ${invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString("en-CA") : "N/A"}</p>
<p>Thank you for your business.</p>`;
    }

    // Send via Resend with attachment
    const config = await getProviderConfig("resend");
    const apiKey = config.api_key;
    if (!apiKey) throw new Error("Resend API key not configured");

    const fromEmail = config.from_email || "noreply@openrental.example";
    const fromName = config.from_name || "OpenRental";
    const replyTo = config.reply_to || undefined;

    const { Resend } = await import("resend");
    const resend = new Resend(apiKey);

    const emailPayload: CreateEmailOptions = {
      from: `${fromName} <${fromEmail}>`,
      to: customer.email,
      subject,
      html: applyEmailSignature(html, config.signature || ""),
      attachments: [
        {
          filename: `${invoice.invoiceNumber}.pdf`,
          content: pdfBuffer,
        },
      ],
    };
    if (replyTo) emailPayload.replyTo = replyTo;
    if (config.bcc_admin) emailPayload.bcc = config.bcc_admin;

    await resend.emails.send(emailPayload);

    // Delivery actually happened — stamp it. Every early return above (channel
    // disabled, no customer email, no API key) leaves emailSentAt NULL, which
    // is what keeps the "Emailed" badge honest.
    await db
      .update(schema.invoices)
      .set({ emailSentAt: new Date() })
      .where(eq(schema.invoices.id, invoiceId));

    await logNotification("email", customer.email, subject, "invoice_created", "sent", undefined, "invoice", invoiceId);
    logger.info("[Notifications] Invoice email sent", { invoiceId, to: customer.email });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[Notifications] Invoice email failed", { invoiceId, error: message });
    await logNotification("email", "", `Invoice #${invoiceId}`, "invoice_created", "failed", message, "invoice", invoiceId);
  }
}

// ─── Order Confirmation Email (with PDF attachment) ──────────
export async function sendOrderConfirmationEmail(rentalId: number): Promise<void> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Check if auto-send is enabled
    const settingsRows = await db.select().from(schema.rentalSettings);
    const settingsMap: Record<string, string> = {};
    for (const r of settingsRows) settingsMap[r.key] = r.value;
    if (settingsMap.order_confirmation_auto_send === "false") {
      logger.info("[Notifications] Order confirmation auto-send disabled, skipping");
      return;
    }

    // Respect the global email toggle (notification_settings global.email_enabled)
    if (!(await isChannelEnabled("email"))) {
      logger.info("[Notifications] Email globally disabled, skipping order confirmation email");
      return;
    }

    // Fetch rental
    const [rental] = await db
      .select()
      .from(schema.rentalRequests)
      .where(and(eq(schema.rentalRequests.id, rentalId), isNull(schema.rentalRequests.deletedAt)))
      .limit(1);

    if (!rental) throw new Error(`Rental #${rentalId} not found`);
    if (!rental.customerEmail) {
      logger.warn("[Notifications] No customer email for rental", { rentalId });
      return;
    }

    // Generate PDF if not already generated
    let pdfUrl = rental.orderConfirmationPdfUrl;
    if (!pdfUrl) {
      const { generateOrderConfirmationPDF } = await import("./orderConfirmationPDF");
      const result = await generateOrderConfirmationPDF(rentalId);
      pdfUrl = result.url;
    }

    // Fetch PDF as buffer for attachment
    const pdfResponse = await fetch(pdfUrl);
    if (!pdfResponse.ok) throw new Error(`Failed to fetch PDF from ${pdfUrl}`);
    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());

    // Look for a rental_approved template
    const templates = await db
      .select()
      .from(schema.notificationTemplates)
      .where(and(
        eq(schema.notificationTemplates.event, "rental_approved"),
        eq(schema.notificationTemplates.isActive, true),
        eq(schema.notificationTemplates.channel, "email"),
      ))
      .limit(1);

    const variables: Record<string, string> = {
      customerName: rental.customerName,
      rentalId: rental.rentalNumber || String(rental.id),
      startDate: rental.startDate.toLocaleDateString("en-CA"),
      endDate: rental.endDate.toLocaleDateString("en-CA"),
      totalAmount: `$${Number(rental.totalAmount || 0).toFixed(2)}`,
    };

    let subject: string;
    let html: string;

    if (templates.length > 0) {
      subject = renderTemplate(templates[0].subject || "Order Confirmation - Rental #{{rentalId}}", variables);
      html = renderTemplate(templates[0].body, variables);
    } else {
      subject = `Order Confirmation - Rental ${rental.rentalNumber || `#${rental.id}`}`;
      html = `<p>Dear ${rental.customerName},</p>
<p>Your rental order <strong>${rental.rentalNumber || `#${rental.id}`}</strong> has been approved!</p>
<p><strong>Rental Period:</strong> ${rental.startDate.toLocaleDateString("en-CA")} to ${rental.endDate.toLocaleDateString("en-CA")}<br/>
<strong>Total:</strong> $${Number(rental.totalAmount || 0).toFixed(2)}</p>
<p>Please find your order confirmation attached.</p>
<p>Thank you for choosing OpenRental.</p>`;
    }

    // Send via Resend with attachment
    const config = await getProviderConfig("resend");
    const apiKey = config.api_key;
    if (!apiKey) throw new Error("Resend API key not configured");

    const fromEmail = config.from_email || "noreply@openrental.example";
    const fromName = config.from_name || "OpenRental";
    const replyTo = config.reply_to || undefined;

    const { Resend } = await import("resend");
    const resend = new Resend(apiKey);

    const emailPayload: CreateEmailOptions = {
      from: `${fromName} <${fromEmail}>`,
      to: rental.customerEmail,
      subject,
      html: applyEmailSignature(html, config.signature || ""),
      attachments: [
        {
          filename: `order-confirmation-${rental.rentalNumber || rental.id}.pdf`,
          content: pdfBuffer,
        },
      ],
    };
    if (replyTo) emailPayload.replyTo = replyTo;
    if (config.bcc_admin) emailPayload.bcc = config.bcc_admin;

    await resend.emails.send(emailPayload);

    await logNotification("email", rental.customerEmail, subject, "rental_approved", "sent", undefined, "rental", rentalId);
    logger.info("[Notifications] Order confirmation email sent", { rentalId, to: rental.customerEmail });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[Notifications] Order confirmation email failed", { rentalId, error: message });
    await logNotification("email", "", `Order Confirmation #${rentalId}`, "rental_approved", "failed", message, "rental", rentalId);
  }
}

// ─── Event-based notifications ───────────────────────────────
export async function notifyOnEvent(event: string, variables: Record<string, string>) {
  try {
    const db = await getDb();
    if (!db) return;

    // Check event preference
    const globalConfig = await getProviderConfig("global");
    const eventKey = `event_${event}`;
    if (globalConfig[eventKey] === "false") return; // event disabled

    const templates = await db
      .select()
      .from(schema.notificationTemplates)
      .where(and(
        eq(schema.notificationTemplates.event, event),
        eq(schema.notificationTemplates.isActive, true),
      ));

    for (const tmpl of templates) {
      const body = renderTemplate(tmpl.body, variables);
      const subject = tmpl.subject ? renderTemplate(tmpl.subject, variables) : undefined;

      if (tmpl.channel === "email" && variables.email) {
        await sendEmail(variables.email, subject || event, body, event);
      } else if (tmpl.channel === "sms" && variables.phone) {
        await sendSMS(variables.phone, body, event);
      }
    }

    // Also notify admin if configured
    const adminEmail = globalConfig.admin_notification_email;
    if (adminEmail && templates.length > 0) {
      const adminEvents = (globalConfig.admin_notify_events || "rental_pending").split(",");
      if (adminEvents.includes(event)) {
        const adminBody = `<p>Notification event: <strong>${event}</strong></p><p>Customer: ${variables.customerName || "N/A"}</p><p>Rental #${variables.rentalId || "N/A"}</p>`;
        await sendEmail(adminEmail, `[Admin] ${event.replace(/_/g, " ")}`, adminBody, event);
      }
    }
  } catch (err) {
    logger.error("[Notifications] Event notification failed", { event, error: err instanceof Error ? err.message : String(err) });
  }
}
