#!/usr/bin/env python3
"""Parse a filled-in 客户分类勾选表 PDF into JSON for import-classification.ts.

Reads the AcroForm checkbox states — field names are c{customerId}_i_{industry}
and c{customerId}_l_{language}, checked == /V of /Yes — and reduces them to one
suggestion per customer per dimension.

Pure read: no database access, no writes anywhere except the output JSON.

  python3 scripts/parse-classification-pdf.py <filled.pdf> <out.json>

Per customer per dimension:
  - exactly one box checked  -> that value
  - no box checked           -> null (paper says nothing; importer leaves the field alone)
  - multiple boxes checked   -> conflict (importer skips the field and reports it;
                                happens when staff tick the right box but forget
                                to untick the pre-checked wrong one)
"""
import json
import re
import sys

from pypdf import PdfReader

FIELD_RE = re.compile(r"^c(\d+)_(i|l)_([a-z_]+)$")


def parse(pdf_path: str) -> dict:
    fields = PdfReader(pdf_path).get_fields() or {}
    customers: dict[int, dict] = {}
    unrecognized = []

    for name, field in fields.items():
        m = FIELD_RE.match(name)
        if not m:
            unrecognized.append(name)
            continue
        cid, dim, value = int(m.group(1)), m.group(2), m.group(3)
        checked = field.get("/V") == "/Yes"
        entry = customers.setdefault(cid, {"industry": [], "language": []})
        if checked:
            entry["industry" if dim == "i" else "language"].append(value)

    rows = []
    for cid in sorted(customers):
        picks = customers[cid]
        row = {"customerId": cid}
        for dim in ("industry", "language"):
            vals = picks[dim]
            if len(vals) == 1:
                row[dim] = vals[0]
            elif len(vals) == 0:
                row[dim] = None
            else:
                row[dim] = None
                row[f"{dim}Conflict"] = sorted(vals)
        rows.append(row)

    return {
        "source": pdf_path,
        "customerCount": len(rows),
        "unrecognizedFields": unrecognized,
        "rows": rows,
    }


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    result = parse(sys.argv[1])
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    conflicts = sum(1 for r in result["rows"] if "industryConflict" in r or "languageConflict" in r)
    picked_i = sum(1 for r in result["rows"] if r.get("industry"))
    picked_l = sum(1 for r in result["rows"] if r.get("language"))
    print(f"客户: {result['customerCount']}  行业已勾: {picked_i}  语言已勾: {picked_l}  冲突: {conflicts}")
    if result["unrecognizedFields"]:
        print(f"⚠️ 无法识别的表单字段: {result['unrecognizedFields'][:5]}")


if __name__ == "__main__":
    main()
