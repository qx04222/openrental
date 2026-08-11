/**
 * AI 预分类脚本 — 给在用客户建议 industry / preferredLanguage(migration 151)。
 *
 * 纯规则匹配(不调用任何 LLM API):按 name/company/notes 命中关键词猜行业，
 * 按姓名是否含中文字符 / 是否命中常见西人 first name 猜语言。命中不了就留 NULL，
 * 交给人工在 /admin/customer-classification 里确认——宁可留白也不要瞎猜.
 *
 *   Dry run:  npx tsx scripts/classify-customers.ts
 *   Commit:   npx tsx scripts/classify-customers.ts --commit
 *             （commit 只回填当前为 NULL 的字段，不覆盖已有值，也不写 confirmedAt——
 *              人工确认必须由人工在管理页里点，不是这个脚本能替代的）
 */
import "dotenv/config";
import { getDb, sql } from "../server/db";
import type { CustomerIndustry, CustomerLanguage } from "../shared/customerClassification";

interface CustomerRow {
  id: number;
  name: string;
  company: string | null;
  notes: string | null;
  industry: string | null;
  preferredLanguage: string | null;
  equipmentDescriptions: string | null; // 该客户最近几单的 equipmentDescription，'|' 拼接
}

interface IndustryRule {
  industry: CustomerIndustry;
  // 关键词按需求逐条写出，避免用户没读过的正则打包成一个大 regex 隐藏命中细节。
  keywords: RegExp[];
}

// 顺序即优先级：先匹配到先得。都不中则行业留 NULL。
const INDUSTRY_RULES: IndustryRule[] = [
  {
    industry: "landscaping",
    keywords: [/landscap/i, /artscape/i, /interlock/i, /pool/i, /garden/i, /lawn/i, /园艺/, /绿化/, /景观/],
  },
  {
    industry: "renovation",
    keywords: [/renovat/i, /roof/i, /interior/i, /flooring/i, /paint/i, /装修/, /翻新/],
  },
  {
    industry: "mechanical",
    keywords: [/mechanical/i, /electric/i, /hvac/i, /plumb/i, /机电/],
  },
  {
    // Checked BEFORE general_contractor on purpose: "NLD Real Estate
    // Development" should read as property, but general_contractor's very
    // generic /development/ keyword would grab it first.
    industry: "property",
    keywords: [/real estate/i, /\bproperty\b/i, /\brealty\b/i, /地产/, /物业/],
  },
  {
    industry: "general_contractor",
    keywords: [/construc/i, /builder/i, /\bhomes\b/i, /contract/i, /development/i, /建筑/, /总包/],
  },
];

// company 为空且 name 不含公司后缀时，才有资格判 individual —— 但前提是不命中上面任何行业词。
const COMPANY_SUFFIX = /\b(inc|ltd|corp|llc)\b/i;

// 常见西人 first name，用来判断"这明显是个英文名"。故意保守，只列高置信度的。
const COMMON_ENGLISH_FIRST_NAMES = [
  "john", "mike", "michael", "sarah", "david", "james", "robert", "mary",
  "jennifer", "chris", "christopher", "matthew", "daniel", "paul", "mark",
  "steven", "steve", "andrew", "kevin", "brian", "george", "edward", "ryan",
  "jason", "jeff", "jeffrey", "richard", "thomas", "tom", "william", "bill",
  "joseph", "joe", "charles", "peter", "patrick", "scott", "eric", "kenneth",
  "kyle", "brandon", "jonathan", "justin", "nathan", "adam", "nicholas",
  "nick", "sean", "gary", "larry", "frank", "greg", "gregory", "raymond",
  "susan", "linda", "karen", "nancy", "lisa", "betty", "margaret",
  "sandra", "ashley", "kimberly", "emily", "michelle", "amanda", "melissa",
  "laura", "rebecca", "stephanie", "amy", "anna", "donna", "carol",
];

const CHINESE_CHAR_RE = /[一-鿿]/;

function detectIndustry(name: string, company: string, notes: string, equipment: string): { industry: CustomerIndustry | null; reason: string } {
  const haystack = `${name} ${company} ${notes}`.toLowerCase();
  const rawHaystack = `${name} ${company} ${notes}`;
  for (const rule of INDUSTRY_RULES) {
    for (const kw of rule.keywords) {
      if (kw.test(rawHaystack) || kw.test(haystack)) {
        return { industry: rule.industry, reason: `命中"${kw.source}" → ${rule.industry}` };
      }
    }
  }
  // 没命中行业词：company 为空且 name 不含公司后缀 → individual
  if (!company.trim() && !COMPANY_SUFFIX.test(name)) {
    return { industry: "individual", reason: "无公司名且姓名无公司后缀 → individual" };
  }
  return { industry: null, reason: "无命中，留人工" };
}

function detectLanguage(name: string, notes: string): { lang: CustomerLanguage | null; reason: string } {
  if (CHINESE_CHAR_RE.test(name) || CHINESE_CHAR_RE.test(notes)) {
    return { lang: "zh", reason: "姓名/备注含中文字符 → zh" };
  }
  const firstWord = name.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  if (COMMON_ENGLISH_FIRST_NAMES.includes(firstWord)) {
    return { lang: "en", reason: `姓名首词"${firstWord}"命中常见英文名 → en` };
  }
  return { lang: null, reason: "无法保守判定，留人工" };
}

async function main() {
  const commit = process.argv.includes("--commit");
  const db = await getDb();
  if (!db) throw new Error("no db");

  // 只读:在用客户 + 最近几单的 equipmentDescription（拼接展示用，当前分类规则未使用设备描述，
  // 但按任务要求取出以备将来规则扩展/人工核对时参考）。
  const rows = (await db.execute(sql`
    SELECT
      c.id,
      c.name,
      c.company,
      c.notes,
      c.industry,
      c."preferredLanguage",
      (
        SELECT string_agg(r."equipmentDescription", ' | ')
        FROM (
          SELECT "equipmentDescription"
          FROM rental_requests
          WHERE "customerId" = c.id AND "deletedAt" IS NULL AND "equipmentDescription" IS NOT NULL
          ORDER BY id DESC
          LIMIT 3
        ) r
      ) AS "equipmentDescriptions"
    FROM customers c
    WHERE c."deletedAt" IS NULL
    ORDER BY c.id
  `)) as unknown as CustomerRow[];

  console.log(`在用客户: ${rows.length}`);

  const results: {
    row: CustomerRow;
    industry: CustomerIndustry | null;
    industryReason: string;
    lang: CustomerLanguage | null;
    langReason: string;
  }[] = [];

  for (const row of rows) {
    const name = row.name ?? "";
    const company = row.company ?? "";
    const notes = row.notes ?? "";
    const equipment = row.equipmentDescriptions ?? "";
    const { industry, reason: industryReason } = detectIndustry(name, company, notes, equipment);
    const { lang, reason: langReason } = detectLanguage(name, notes);
    results.push({ row, industry, industryReason, lang, langReason });
  }

  // dry-run 对齐表格
  console.log("\n--- 预分类结果 ---");
  const nameW = 24;
  const indW = 20;
  const langW = 8;
  const header = `${"客户名".padEnd(nameW)}${"建议行业".padEnd(indW)}${"建议语言".padEnd(langW)}依据`;
  console.log(header);
  console.log("-".repeat(header.length + 40));
  for (const r of results) {
    const displayName = (r.row.company ? `${r.row.name}(${r.row.company})` : r.row.name).slice(0, nameW - 1);
    const indDisplay = (r.industry ?? "—").padEnd(indW);
    const langDisplay = (r.lang ?? "—").padEnd(langW);
    const reason = `industry: ${r.industryReason}; lang: ${r.langReason}`;
    console.log(`${displayName.padEnd(nameW)}${indDisplay}${langDisplay}${reason}`);
  }

  // 统计
  const industryCounts = new Map<string, number>();
  const langCounts = new Map<string, number>();
  for (const r of results) {
    const ik = r.industry ?? "(null)";
    const lk = r.lang ?? "(null)";
    industryCounts.set(ik, (industryCounts.get(ik) ?? 0) + 1);
    langCounts.set(lk, (langCounts.get(lk) ?? 0) + 1);
  }
  console.log("\n--- 行业分布 ---");
  for (const [k, v] of [...industryCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
  console.log("\n--- 语言分布 ---");
  for (const [k, v] of [...langCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }

  // 已有值统计:只更新当前为 NULL 的字段，已有值的行不会被这个脚本触碰。
  const alreadyIndustry = rows.filter((r) => r.industry != null).length;
  const alreadyLang = rows.filter((r) => r.preferredLanguage != null).length;
  console.log(`\n已有 industry 的客户: ${alreadyIndustry}（脚本不会覆盖）`);
  console.log(`已有 preferredLanguage 的客户: ${alreadyLang}（脚本不会覆盖）`);

  if (!commit) {
    console.log("\n--- DRY RUN，未写入。加 --commit 执行。 ---");
    return;
  }

  let industryUpdated = 0;
  let langUpdated = 0;
  for (const r of results) {
    if (r.industry != null && r.row.industry == null) {
      await db.execute(sql`
        UPDATE customers SET industry = ${r.industry}, "updatedAt" = now()
        WHERE id = ${r.row.id} AND industry IS NULL
      `);
      industryUpdated += 1;
    }
    if (r.lang != null && r.row.preferredLanguage == null) {
      await db.execute(sql`
        UPDATE customers SET "preferredLanguage" = ${r.lang}, "updatedAt" = now()
        WHERE id = ${r.row.id} AND "preferredLanguage" IS NULL
      `);
      langUpdated += 1;
    }
  }
  console.log(`\n已写入 industry: ${industryUpdated}`);
  console.log(`已写入 preferredLanguage: ${langUpdated}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
