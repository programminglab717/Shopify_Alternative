#!/usr/bin/env python3
"""Regenerate the summary table in docs/product/02-feature-catalog.md.

Counts every feature row (| ID | Feature | Notes | Type | Phase |) by Type and
Phase, checks for duplicate IDs, and rewrites the block between the
SUMMARY:START / SUMMARY:END markers.
"""
import collections
import pathlib
import re
import sys

CATALOG = pathlib.Path(__file__).resolve().parent.parent / "docs/product/02-feature-catalog.md"
PHASES = ["MVP", "V1", "GROWTH", "SCALE"]
TYPES = ["PARITY", "LOCAL", "BEYOND"]
ROW = re.compile(r"^\| ([A-Z]+-\d+) \|")


def main() -> int:
    text = CATALOG.read_text(encoding="utf-8")
    counts = collections.Counter()
    seen, dupes = set(), []
    for line in text.splitlines():
        if not ROW.match(line):
            continue
        cols = [c.strip() for c in line.strip().strip("|").split("|")]
        fid, ftype, phase = cols[0], cols[-2], cols[-1]
        if ftype not in TYPES or phase not in PHASES:
            print(f"{fid}: unknown type/phase {ftype!r}/{phase!r}", file=sys.stderr)
            return 1
        if fid in seen:
            dupes.append(fid)
        seen.add(fid)
        counts[(ftype, phase)] += 1
    if dupes:
        print(f"duplicate IDs: {', '.join(dupes)}", file=sys.stderr)
        return 1

    total = sum(counts.values())
    lines = [
        f"{total} features across 24 domains. Counts are generated from the tables below; "
        "run `python3 scripts/update_feature_summary.py` after editing.",
        "",
        "| Type \\ Phase | " + " | ".join(PHASES) + " | Total |",
        "|---|" + "---|" * (len(PHASES) + 1),
    ]
    for t in TYPES:
        row = [str(counts[(t, p)]) for p in PHASES]
        lines.append(f"| **{t}** | " + " | ".join(row) + f" | **{sum(counts[(t, p)] for p in PHASES)}** |")
    col_totals = [f"**{sum(counts[(t, p)] for t in TYPES)}**" for p in PHASES]
    lines.append("| **Total** | " + " | ".join(col_totals) + f" | **{total}** |")

    block = "<!-- SUMMARY:START -->\n" + "\n".join(lines) + "\n<!-- SUMMARY:END -->"
    new = re.sub(r"<!-- SUMMARY:START -->.*?<!-- SUMMARY:END -->", block, text, flags=re.S)
    CATALOG.write_text(new, encoding="utf-8")
    print(f"updated summary: {total} features")
    return 0


if __name__ == "__main__":
    sys.exit(main())
