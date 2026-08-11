/**
 * Import a reviewed 客户分类勾选表 back into the system.
 *
 * Step 1 (pure read):  python3 scripts/parse-classification-pdf.py 已勾选.pdf out.json
 * Step 2 (this):       npx tsx scripts/import-classification.ts out.json           # dry-run
 *                      npx tsx scripts/import-classification.ts out.json --commit
 *
 * The paper IS the human review — a returned worksheet means staff went through
 * it — so imported values land as CONFIRMED (classificationConfirmedAt/By),
 * unlike classify-customers.ts whose machine suggestions never confirm.
 *
 * Field-level rules, each dimension independent:
 *   - value present      -> write it, even over an existing value (the paper is
 *                           newer than the suggestion it corrects)
 *   - null, no conflict  -> leave the field exactly as it is (paper said nothing)
 *   - conflict           -> first try to resolve it against the pre-checked
 *                           suggestion. The worksheet's own instruction says
 *                           "错的把对的格勾上" (tick the correct box), so
 *                           {pre-checked value + exactly one new tick} is the
 *                           documented correction gesture — the new tick wins.
 *                           The DB value doubles as the pre-check reference,
 *                           sound only while nothing was confirmed in-app since
 *                           the sheet was printed; the script verifies that and
 *                           refuses otherwise. Anything still ambiguous after
 *                           removing the pre-check is skipped and listed; staff
 *                           ticked two boxes (usually fixed one, forgot to
 *                           untick the pre-checked other) and only a human
 *                           knows which they meant
 * A customer is stamped confirmed only when at least one field was written.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { getDb, eq, and, isNull, isNotNull, inArray, sql } from "../server/db";
import * as schema from "../drizzle/schema";
import {
  CUSTOMER_INDUSTRIES,
  CUSTOMER_LANGUAGES,
} from "../shared/customerClassification";

interface Row {
  customerId: number;
  industry: string | null;
  language: string | null;
  industryConflict?: string[];
  languageConflict?: string[];
}

/** Multi-industry resolution (decision C, 2026-07-24): several industry ticks
 * are not a mistake — a fifth of the base straddles trades. The pre-checked
 * value stays PRIMARY (it keeps reports conservative) and the new ticks become
 * secondaries; with no usable pre-check the first tick is primary. Industry
 * conflicts therefore no longer exist. Language stays single-valued, so its
 * old rule (pre-check + one new tick = correction) still applies. */

async function main() {
  const [jsonPath, ...flags] = process.argv.slice(2);
  const commit = flags.includes("--commit");
  // --baseline <file>: use this parse of the UNFILLED sheet as the pre-check
  // reference instead of the DB (needed when the DB was already written to
  // since the sheet was printed).
  const baselineIdx = flags.indexOf("--baseline");
  const baselinePath = baselineIdx >= 0 ? flags[baselineIdx + 1] : null;
  if (!jsonPath) {
    console.error("用法: npx tsx scripts/import-classification.ts <parsed.json> [--baseline unfilled.json] [--commit]");
    process.exit(2);
  }

  const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as { rows: Row[]; source: string };
  const baseline = baselinePath
    ? new Map(
        (JSON.parse(readFileSync(baselinePath, "utf8")) as { rows: Row[] }).rows
          .map((r) => [r.customerId, { industry: r.industry, language: r.language }]),
      )
    : null;
  const db = await getDb();
  if (!db) throw new Error("no db");

  // Confirmed-by needs a real user; the earlier backfills used the same rule.
  const [admin] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.role, "super_admin"))
    .limit(1);

  const ids = parsed.rows.map((r) => r.customerId);
  const existing = await db
    .select({
      id: schema.customers.id,
      name: schema.customers.name,
      industry: schema.customers.industry,
      secondaryIndustries: schema.customers.secondaryIndustries,
      preferredLanguage: schema.customers.preferredLanguage,
    })
    .from(schema.customers)
    .where(and(inArray(schema.customers.id, ids), isNull(schema.customers.deletedAt)));
  const byId = new Map(existing.map((c) => [c.id, c]));

  // The DB value stands in for "what was pre-checked on the printed sheet",
  // which only holds while nobody confirmed classification in-app after the
  // sheet was generated. Refuse rather than mis-resolve.
  const [{ count: confirmedCount }] = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.customers)
    .where(and(isNull(schema.customers.deletedAt), isNotNull(schema.customers.classificationConfirmedAt)))) as { count: number }[];
  if (confirmedCount > 0 && !baseline) {
    console.error(`⚠️ 系统里已有 ${confirmedCount} 个客户被人工确认过,库值不再等于表格预勾值。请用 --baseline 提供未填表的解析档,或在「客户分类」页人工处理。`);
    process.exit(1);
  }

  const changes: { id: number; name: string; patch: Record<string, string | string[]>; diff: string[] }[] = [];
  const resolved: string[] = [];
  const conflicts: string[] = [];
  const missing: number[] = [];
  let invalid = 0;

  for (const row of parsed.rows) {
    const cur = byId.get(row.customerId);
    if (!cur) {
      missing.push(row.customerId);
      continue;
    }
    const refIndustry = baseline ? baseline.get(row.customerId)?.industry ?? null : cur.industry;
    const refLanguage = baseline ? baseline.get(row.customerId)?.language ?? null : cur.preferredLanguage;
    let secondaries: string[] | undefined;
    if (row.industryConflict) {
      const set = row.industryConflict;
      if (refIndustry && set.includes(refIndustry)) {
        row.industry = refIndustry;
        secondaries = set.filter((v) => v !== refIndustry);
      } else {
        row.industry = set[0];
        secondaries = set.slice(1);
      }
      resolved.push(`${cur.name}: 多行业 → 主营${row.industry} + 副营[${secondaries.join(", ")}]`);
    }
    if (row.languageConflict) {
      const added = row.languageConflict.filter((v) => v !== refLanguage);
      if (refLanguage && row.languageConflict.includes(refLanguage) && added.length === 1) {
        row.language = added[0];
        resolved.push(`${cur.name}: 语言 预勾${refLanguage} + 新勾${added[0]} → 取新勾`);
      } else {
        conflicts.push(`${cur.name}: 语言勾了多个 [${row.languageConflict.join(", ")}]`);
      }
    }

    const patch: Record<string, string | string[]> = {};
    const diff: string[] = [];

    if (row.industry) {
      if (!(CUSTOMER_INDUSTRIES as readonly string[]).includes(row.industry)) { invalid += 1; continue; }
      if (row.industry !== cur.industry) {
        patch.industry = row.industry;
        diff.push(`行业 ${cur.industry ?? "空"} → ${row.industry}`);
      } else {
        // Same value the suggestion had — the tick is still a human sign-off.
        patch.industry = row.industry;
      }
    }
    if (row.language) {
      if (!(CUSTOMER_LANGUAGES as readonly string[]).includes(row.language)) { invalid += 1; continue; }
      if (row.language !== cur.preferredLanguage) {
        patch.preferredLanguage = row.language;
        diff.push(`语言 ${cur.preferredLanguage ?? "空"} → ${row.language}`);
      } else {
        patch.preferredLanguage = row.language;
      }
    }

    if (secondaries !== undefined) {
      const curSec = ((cur as { secondaryIndustries?: string[] }).secondaryIndustries ?? []);
      if (JSON.stringify([...curSec].sort()) !== JSON.stringify([...secondaries].sort())) {
        patch.secondaryIndustries = secondaries;
        diff.push(`副营 [${curSec.join(",") || "空"}] → [${secondaries.join(",")}]`);
      }
    }
    if (Object.keys(patch).length > 0) changes.push({ id: cur.id, name: cur.name, patch, diff });
  }

  const valueChanges = changes.filter((c) => c.diff.length > 0);
  console.log(`来源: ${parsed.source}`);
  console.log(`表格客户: ${parsed.rows.length}  可导入: ${changes.length}  其中值有变化: ${valueChanges.length}`);
  if (missing.length) console.log(`⚠️ 已不存在/已删除的客户,跳过: ${missing.join(", ")}`);
  if (invalid) console.log(`⚠️ 词表外的值(表格版本不匹配?),跳过字段: ${invalid} 处`);
  if (resolved.length) {
    console.log(`\n✓ 按「勾了对的、留着预勾」惯例自动解决 (${resolved.length}):`);
    for (const r of resolved) console.log(`   ${r}`);
  }
  if (conflicts.length) {
    console.log(`\n⚠️ 冲突(勾了多个,该字段未导入,需在系统里人工定):`);
    for (const c of conflicts) console.log(`   ${c}`);
  }
  if (valueChanges.length) {
    console.log(`\n--- 值变化明细 ---`);
    for (const c of valueChanges) console.log(`  ${c.name}: ${c.diff.join("; ")}`);
  }

  if (!commit) {
    console.log(`\n--- DRY RUN,未写入。加 --commit 执行(导入即视为员工已确认)。 ---`);
    return;
  }

  let done = 0;
  for (const c of changes) {
    await db
      .update(schema.customers)
      .set({
        ...c.patch,
        classificationConfirmedAt: new Date(),
        classificationConfirmedBy: admin?.id ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.customers.id, c.id), isNull(schema.customers.deletedAt)));
    done += 1;
  }
  console.log(`\n已写入并确认: ${done} 个客户`);
  if (conflicts.length) console.log(`冲突的 ${conflicts.length} 处未动,请在「客户分类」页人工处理。`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
