/**
 * Default contract template seed.
 * Inserts the OpenRental Equipment Rental Agreement (KD v2, English) as the
 * default template if no templates exist yet.
 *
 * Markdown conventions understood by contractPDF.ts:
 *   #   centered document title
 *   ##  red section heading
 *   ### subsection heading
 *   --- horizontal divider
 *   plain text = body paragraph
 * Single-brace {tokens} are substituted with rental data at render time.
 * The [[LESSOR_SIGNATURE]] marker renders the built-in typeset company
 * signature (see contractPDF.ts).
 */

import { getDb } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";

export const DEFAULT_CONTRACT_TEMPLATE_CONTENT = `# OPENRENTAL EQUIPMENT RENTAL AGREEMENT

This Equipment Rental Agreement ("Agreement") is entered into on {effectiveDate} ("Effective Date") between OpenRental ("Lessor") and {customerName} ("Lessee").

## 1. EQUIPMENT RENTAL
The Lessor agrees to rent to the Lessee the following equipment: {equipmentDescription}, serial number {equipmentSerial}. The rental period shall commence on {startDate} and terminate on {endDate}. The equipment shall be picked up from {deliveryAddress} and returned to {deliveryAddress} unless otherwise agreed to in writing by the Lessor.

## 2. RENTAL FEES
The Lessee agrees to pay rental charges based on the following applicable rates: daily rate of {dailyRate}, weekly rate of {weeklyRate}, and monthly rate of {monthlyRate}, together with a refundable security deposit of {deposit}. Additional charges may apply for delivery, fuel usage, excessive wear, cleaning, damages, or other related expenses incurred during the rental period. Cleaning charges shall be assessed as follows: light cleaning at $50, moderate cleaning at $150, and heavy cleaning at $300. Any late return shall result in additional rental charges equal to twenty percent (20%) of the applicable daily rental rate per day, prorated hourly where applicable, together with any associated administrative or loss-of-use charges until the equipment is returned and accepted by the Lessor.

### Rental Protection Plan (Optional)
The Lessee may elect to participate in the Lessor's Rental Protection Plan ("RPP") for an additional charge equal to fifteen percent (15%) of the applicable rental charges. Please see Section 8 for detail.
[  ] Accept Rental Protection Plan (RPP)          [  ] Decline Rental Protection Plan (RPP)

## 3. RENTAL PERIOD AND EXCESS UTILIZATION
For the purposes of this Agreement, rental periods and equipment utilization limits shall be defined as follows: (a) One (1) day rental consists of twenty-four (24) consecutive hours, with equipment utilization not to exceed eight (8) operating hours. (b) One (1) week rental consists of seven (7) consecutive days totaling one hundred sixty-eight (168) hours, with equipment utilization not to exceed forty (40) operating hours. (c) One (1) month rental consists of twenty-eight (28) consecutive days totaling six hundred seventy-two (672) hours, with equipment utilization not to exceed one hundred sixty (160) operating hours. Rental charges commence when the equipment leaves the possession of the Lessor and continue until the equipment is returned and accepted by the Lessor. Any extension of the rental period must be approved by the Lessor and shall be subject to additional charges.

If equipment utilization exceeds the operating hour limits above, additional charges shall apply unless otherwise agreed in writing. (i) Daily rentals: excess hours charged at 1/8 of the daily rental rate per hour. (ii) Weekly rentals: excess hours charged at 1/40 of the weekly rental rate per hour. (iii) Monthly rentals: excess hours charged at 1/160 of the monthly rental rate per hour. Rental charges shall not be reduced or refunded due to partial use, non-use, weather delays, job delays, early return, or downtime not caused by the Lessor. The equipment hour meter shall be conclusive evidence of operating hours unless otherwise proven by written evidence acceptable to the Lessor.

## 4. INSURANCE REQUIREMENTS
The Lessee shall, at its sole cost and expense, maintain valid and enforceable insurance coverage throughout the entire rental period and until the equipment is returned and accepted by the Lessor. The Lessee shall maintain: (a) Commercial General Liability Insurance with a minimum limit of $2,000,000 per occurrence for bodily injury, property damage, and personal injury liability, including contractual liability, cross liability, and Products & Completed Operations coverage where applicable; (b) Contractors' Equipment Coverage and Property Insurance sufficient to cover the full replacement value of the rented equipment without depreciation, including coverage for theft, vandalism, fire, collision, overturning, transportation, and other insured perils; and (c) Automobile Liability Insurance with a minimum limit of $2,000,000 per occurrence where the equipment is transported or operated using vehicles owned, leased, rented, or controlled by the Lessee.

Prior to the release of any equipment, the Lessee shall provide proof of insurance satisfactory to the Lessor upon request. The Lessee further agrees that: (a) the Lessor shall be added as an Additional Insured under the Lessee's Commercial General Liability policy; (b) all applicable insurance policies shall include a waiver of subrogation in favor of the Lessor; and (c) the Lessee remains fully responsible for ensuring that its insurance coverage adequately protects against all risks associated with the rental, possession, operation, transportation, and storage of the equipment. The Lessee acknowledges that any review, acceptance, or failure by the Lessor to request or verify insurance documentation shall not relieve the Lessee of its obligations or liabilities under this Agreement.

## 5. CONDITION, USE, AND OPERATION OF EQUIPMENT
The Lessee acknowledges that the equipment has been inspected prior to rental and accepted in good working condition. The equipment shall only be operated by properly trained and qualified individuals and shall be used strictly in accordance with applicable laws, manufacturer guidelines, and industry safety standards. The Lessee shall not sublease, lend, misuse, overload, improperly operate, or permit unauthorized use of the equipment. Unless otherwise approved in writing by the Lessor, the equipment shall not be used outside the Province of Ontario, for underground operations, or for demolition work. The Lessor reserves the right to inspect the equipment at any reasonable time during the rental period.

## 6. TRANSPORTATION, RESPONSIBILITY, AND SECURITY
Unless transportation is provided by the Lessor in writing, the Lessee assumes full responsibility and liability for the transportation, loading, unloading, towing, handling, storage, and operation of the equipment from pickup until return and acceptance by the Lessor. Where the equipment is transported or operated using vehicles owned, leased, rented, or controlled by the Lessee, the Lessee shall maintain Automobile Liability Insurance with minimum coverage of CAD $2,000,000 per occurrence. The Lessee shall be responsible for all loss or damage arising from transportation-related incidents, including accidents, rollovers, improper securement, theft, vandalism, weather exposure, or any other cause during transit or storage. The Lessee shall maintain the equipment in a safe and secure manner at all times and take all reasonable precautions to prevent theft, unauthorized use, damage, or loss, including proper overnight storage at job sites. Failure to properly secure or protect the equipment shall not limit the Lessee's liability under this Agreement.

## 7. DAMAGE, LOSS, AND ENVIRONMENTAL LIABILITY
The Lessee shall be fully responsible for any damage to the equipment resulting from negligence, misuse, rough handling, improper operation, inadequate maintenance, or failure to properly protect the job site. Any damage, malfunction, accident, or incident involving the equipment must be reported to the Lessor within one (1) hour of occurrence. In the event the equipment is lost, stolen, destroyed, or deemed a total loss, the Lessee shall pay the full replacement value of the equipment based on current market value without depreciation. The Lessee shall also be solely responsible for any environmental contamination, including fuel spills, oil leaks, pollution, or environmental violations arising from the use or storage of the equipment, and agrees to pay all cleanup, remediation, and related costs, subject to a minimum environmental penalty of $5,000 in addition to actual damages.

## 8. RENTAL PROTECTION PLAN (OPTIONAL)
If the Lessee elects to participate in the Rental Protection Plan ("RPP") and pays the applicable surcharge, the Lessor agrees to waive certain rights of recovery against the Lessee for accidental loss or damage to the equipment, subject to the terms and limitations set out herein. The RPP is not insurance. Participation in the RPP does not relieve the Lessee of its insurance obligations under Section 4 of this Agreement. The RPP applies only where the equipment has been used reasonably, properly, and in accordance with this Agreement. Coverage under the RPP is limited to a maximum of CAD $100,000 per occurrence.

Under the RPP, the Lessee shall remain responsible for: (a) In the event of a total loss, theft, or unrecoverable damage, an amount equal to ten percent (10%) of the current replacement value of the equipment; and (b) In the event of partial damage, ten percent (10%) of the repair costs. For any theft or suspected criminal occurrence, the Lessee must provide a police report to the Lessor within forty-eight (48) hours.

The RPP shall not apply and the Lessee shall remain fully liable for all losses or damages arising from: (i) Overloading, misuse, improper operation, or operation beyond manufacturer capacity ratings; (ii) Tire, track, or undercarriage damage, excessive wear, or failure to properly clean returned equipment, including concrete, asphalt, paint, epoxy, or mud contamination; (iii) Leaving equipment unattended, unsecured, unlocked, or accessible with keys left inside; (iv) Lack of proper lubrication, maintenance, incorrect fuel usage, cold weather damage, or operation without required protective accessories or filters; (v) Improper transportation, loading, unloading, or securement of the equipment; (vi) Negligence, intentional damage, unauthorized possession or use, abusive handling, or exposure to hazardous, radioactive, or contaminated materials.

The Lessee acknowledges that all losses or damages exceeding CAD $100,000, as well as any loss involving hazardous or contaminated materials, remain entirely the responsibility of the Lessee. The Lessor shall retain full subrogation rights against any responsible third party, and the Lessee agrees to reasonably cooperate in enforcing such rights.

## 9. GPS TRACKING
The Lessee acknowledges and agrees that certain equipment may be equipped with GPS tracking systems for security, monitoring, and recovery purposes. The Lessee shall not tamper with, disable, remove, or interfere with any GPS tracking system installed on the equipment.

## 10. INDEMNIFICATION AND LIMITATION OF LIABILITY
The Lessee agrees to indemnify, defend, and hold harmless the Lessor, its officers, employees, and agents from and against any and all claims, liabilities, damages, losses, penalties, fines, legal fees, or expenses arising out of or related to the possession, transportation, operation, or use of the equipment by the Lessee or any third party. Under no circumstances shall the Lessor be liable for project delays, lost profits, business interruption, or any indirect, incidental, or consequential damages arising from the rental or use of the equipment.

## 11. DEFAULT AND TERMINATION
The Lessor may immediately terminate this Agreement and repossess the equipment without notice if the Lessee fails to make payment within twenty-four (24) hours of its due date, fails to maintain the required insurance coverage, or misuses the equipment in any manner. Upon termination, the Lessee shall immediately return the equipment at its sole expense and remain liable for all outstanding charges, damages, and obligations under this Agreement.

## 12. GOVERNING LAW AND FORCE MAJEURE
This Agreement shall be governed by and construed in accordance with the laws of the Province of Ontario. The parties agree that any disputes arising from or relating to this Agreement shall be exclusively resolved in the courts located in Toronto, Ontario.

The Lessor shall not be responsible or liable for any delay, failure in delivery, interruption, or inability to perform any obligation under this Agreement where such failure or delay arises from causes beyond the reasonable control of the Lessor, including but not limited to supplier shortages, transportation delays, strikes, lockouts, fires, floods, severe weather, acts of God, wars, civil unrest, governmental actions, embargoes, terrorism, pandemics, or other unforeseen events or circumstances beyond the Lessor's control.

## 13. WAIVER AND LIMITATION OF RESPONSIBILITY
Under no circumstances shall the Lessor be liable for any damages, losses, injuries, delays, business interruption, or loss of revenue arising out of or related to the use, operation, condition, transportation, or failure of the equipment, including where such damages result from third-party acts, force majeure events, hidden defects, mechanical failures, or circumstances beyond the Lessor's reasonable control.

The Lessee assumes all risks associated with the possession, operation, transportation, storage, and use of the equipment and agrees to indemnify and hold harmless the Lessor from any claims, liabilities, damages, or legal actions arising therefrom. The Lessee further agrees to comply with all applicable municipal, provincial, and federal laws and regulations relating to the use of the equipment, including any requirements applicable to compressed gas tanks, reservoirs, or hazardous materials.

## 14. SIGNATURE
By signing below, the parties acknowledge that they have read, understood, and agree to be bound by all terms and conditions of this Agreement.

LESSOR: OpenRental
[[LESSOR_SIGNATURE]]
Date: {effectiveDate}

LESSEE: {customerName}
[[LESSEE_SIGNATURE]]
Date: {signatureDate}`;

/**
 * Seed the default contract template if no templates exist.
 * Safe to call multiple times — it's a no-op when templates already exist.
 * Returns { seeded: true } if a template was inserted, { seeded: false } otherwise.
 */
export async function seedDefaultContractTemplate(): Promise<{ seeded: boolean; id?: number }> {
  try {
    const db = await getDb();
    if (!db) return { seeded: false };

    // Check if any templates exist
    const existing = await db
      .select({ id: schema.contractTemplates.id })
      .from(schema.contractTemplates)
      .limit(1);

    if (existing.length > 0) {
      return { seeded: false };
    }

    // Insert the default template
    const [result] = await db.insert(schema.contractTemplates).values({
      name: "OpenRental Equipment Rental Agreement",
      content: DEFAULT_CONTRACT_TEMPLATE_CONTENT,
      isDefault: true,
      isActive: true,
    }).returning();

    logger.info("[ContractTemplateSeed] Seeded default contract template", { id: result.id });
    return { seeded: true, id: result.id };
  } catch (error) {
    logger.error("[ContractTemplateSeed] Failed to seed default template", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { seeded: false };
  }
}
