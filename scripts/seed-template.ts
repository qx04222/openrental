import "dotenv/config";
import { getDb, eq } from "../server/db";
import * as schema from "../drizzle/schema";

const ENGLISH_TEMPLATE = `# EQUIPMENT RENTAL TERMS & CONDITIONS ADDENDUM

Effective Date: {effectiveDate}
Agreement #: {agreementNumber}
Parties: OpenRental Trucking Inc. ("Owner") and {customerName} ("Renter")

## 1. INSURANCE & LIABILITY

### 1.1 Mandatory Insurance
Renter must maintain:
- Commercial General Liability Insurance ($2,000,000 minimum).
- Physical Damage Insurance covering the full replacement value of the equipment.

## 2. RENTER'S RESPONSIBILITIES

### 2.1 Operation
- Only trained, qualified personnel may operate the equipment.
- No modifications, subleasing, or use outside Ontario without written consent.

### 2.2 Environmental Compliance
Renter is liable for a $5,000 minimum penalty for spills, contamination, or violations of Ontario's Environmental Protection Act.

### 2.3 Customer Responsibility
Customer is responsible for refuelling, repairs of damage caused by the renter's fault.

## 3. INSPECTIONS

### 3.1 Pre-Rental
Renter must inspect and sign the Equipment Condition Report (Attachment A) before use. Damage/incident not reported within 1 hour waives all claims.

### 3.2 Post-Rental
Owner will inspect equipment upon return. Disputes must be raised within 24 hours.

## 4. FEES & CHARGES

### 4.1 Late Returns
0.2 x the daily rate (prorated hourly)

### 4.2 Cleaning Fees
- Light Dirt: $50
- Moderate Debris: $150
- Excessive Mud/Grease: $300

## 5. DEFAULT & TERMINATION

### 5.1 Immediate Termination
Owner may repossess Equipment without notice for:
- Non-payment after 24 hours.
- Failure to maintain insurance.
- Misuse, illegal activity, or breach of terms.

### 5.2 Retrieval Fee
$500 + towing costs.

## 6. OWNER'S LIABILITY DISCLAIMER

### 6.1 No Liability for Renter's Fault
Owner is not liable for any injury, damage, or loss caused by:
- Renter's misuse, negligence, or breach of this agreement.
- Unauthorized operators, modifications, or improper maintenance.
- Includes third-party claims, business interruptions, or consequential damages.

### 6.2 "AS IS" Basis
Equipment rented "AS IS, WHERE IS" with no warranties of merchantability or fitness.

## 7. INDEMNIFICATION

### 7.1 Renter's Responsibility
Renter agrees to defend, indemnify, and hold Owner harmless from all claims, including:
- Bodily injury, property damage, or environmental violations.
- Legal fees, fines, or costs arising from breach of this agreement.

### 7.2 Survival
Indemnity obligations survive termination.

## 8. NO WAIVER OF SUBROGATION

### 8.1 Insurance Waiver
Renter's insurers waive all rights to pursue recovery from the owner for equipment-related claims.

## 9. LEGAL PROVISIONS

### 9.1 Governing Law
Ontario law; disputes in Toronto courts.

### 9.2 Severability
Invalid clauses do not void the agreement.

---

ATTACHMENT:
- A: Equipment Condition Report (pre/post-inspection)

---

**RENTER ACKNOWLEDGES:**
I have read, understood, and agree to these Terms.

Renter Signature: {renterSignature}    Date: {signatureDate}
Printed Name: {customerName}

Owner Signature: _______________    Date: {effectiveDate}
(OpenRental Trucking Inc Representative)`;

async function main() {
  const db = await getDb();
  if (!db) { console.log("No DB"); process.exit(1); }

  // Update Standard Rental Agreement (id=1) with full English terms
  await db.update(schema.contractTemplates)
    .set({ content: ENGLISH_TEMPLATE })
    .where(eq(schema.contractTemplates.id, 1));

  console.log("Updated Standard Rental Agreement (id=1) with full English terms");
  process.exit(0);
}

main();
