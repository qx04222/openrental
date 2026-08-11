/**
 * Bulk re-generate already-generated rental contracts onto the current
 * DEFAULT template (run scripts/apply-kd-v2-template.ts first).
 *
 *   npx tsx scripts/bulk-regenerate-contracts.ts            # dry run (lists targets)
 *   npx tsx scripts/bulk-regenerate-contracts.ts --apply    # regenerate + upload
 *   npx tsx scripts/bulk-regenerate-contracts.ts --apply --include-signed
 *
 * SAFETY: by default it SKIPS any contract that has been signed (customer
 * signature or signed-at timestamp). Prod currently has 0 signed contracts,
 * so the default scope covers everything. Each run bumps contractVersion and
 * overwrites the stored contract PDF for the rental.
 */
import "dotenv/config";
import { getDb, eq, and, isNull } from "../server/db";
import * as schema from "../drizzle/schema";
import { generateContractPDF } from "../server/services/contractPDF";
import { loadContractLineItems } from "../server/services/contractLineItems";

const APPLY = process.argv.includes("--apply");
const INCLUDE_SIGNED = process.argv.includes("--include-signed");
const ONLY = (() => {
  const a = process.argv.find((x) => x.startsWith("--only="));
  return a ? Number(a.split("=")[1]) : null;
})();

async function main() {
  const db = await getDb();
  if (!db) { console.error("DB unavailable"); process.exit(1); }

  const [def] = await db.select({ id: schema.contractTemplates.id, name: schema.contractTemplates.name })
    .from(schema.contractTemplates)
    .where(eq(schema.contractTemplates.isDefault, true))
    .limit(1);
  if (!def) { console.error("No default template set — run apply-kd-v2-template.ts first"); process.exit(1); }
  console.log(`Default template: #${def.id} "${def.name}"`);

  const rows = await db.select()
    .from(schema.rentalRequests)
    .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
    .where(and(eq(schema.rentalRequests.contractGenerated, true), isNull(schema.rentalRequests.deletedAt)));

  const targets = rows.filter((r) => {
    if (ONLY && r.rental_requests.id !== ONLY) return false;
    const signed = r.rental_requests.contractSignedAt != null || r.rental_requests.customerSignature != null;
    return INCLUDE_SIGNED || !signed;
  });
  const skipped = rows.length - targets.length;
  console.log(`${rows.length} generated contracts; ${targets.length} to regenerate, ${skipped} skipped (signed).`);
  if (!APPLY) {
    for (const r of targets) console.log(`  - #${r.rental_requests.id} ${r.rental_requests.rentalNumber || ""} ${r.rental_requests.customerName}`);
    console.log("\nDRY RUN — re-run with --apply to regenerate.");
    return;
  }

  let ok = 0, fail = 0;
  for (const r of targets) {
    const rr = r.rental_requests;
    try {
      const days = Math.max(1, Math.ceil((rr.endDate.getTime() - rr.startDate.getTime()) / 86400000));
      const { url } = await generateContractPDF({
        rentalId: rr.id,
        rentalNumber: rr.rentalNumber,
        customerName: rr.customerName,
        customerEmail: rr.customerEmail || "",
        customerPhone: rr.customerPhone || "",
        companyName: rr.customerCompany || undefined,
        equipmentBrand: r.rental_fleet?.brand || "",
        equipmentModel: r.rental_fleet?.model || "",
        equipmentCategory: r.rental_fleet?.category || "",
        startDate: rr.startDate,
        endDate: rr.endDate,
        rentalDays: days,
        rentalFee: rr.rentalFee || "0",
        freightCost: rr.freightCost || "0",
        insuranceCost: rr.insuranceCost || "0",
        taxAmount: rr.taxAmount || "0",
        depositAmount: rr.depositAmount || "0",
        totalCost: rr.totalAmount || "0",
        deliveryAddress: rr.deliveryAddress || "Customer pickup",
        projectDescription: rr.projectDescription || undefined,
        contractTemplateId: def.id, // force the new default
        customerSignature: rr.customerSignature,
        customerSignedAt: rr.contractSignedAt,
        repSignature: rr.repSignature,
        repSignedAt: rr.repSignedAt,
        items: await loadContractLineItems(db, rr.id),
      });
      await db.update(schema.rentalRequests).set({
        contractUrl: url,
        contractTemplateId: def.id,
        contractGenerated: true,
        contractGeneratedAt: new Date(),
        contractVersion: (rr.contractVersion || 0) + 1,
      }).where(eq(schema.rentalRequests.id, rr.id));
      ok++;
      console.log(`  ✓ #${rr.id} ${rr.rentalNumber || ""}`);
    } catch (e) {
      fail++;
      console.error(`  ✗ #${rr.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\nDone. ${ok} regenerated, ${fail} failed.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
