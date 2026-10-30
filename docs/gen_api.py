"""Regenerates docs/API.md from the @router.route decorators. Run from the slai_writer folder: python3 docs/gen_api.py"""
import glob
import re
from collections import OrderedDict
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
groups: "OrderedDict[str, list[tuple[str, str, str]]]" = OrderedDict()
for f in sorted(glob.glob(str(HERE / "routes*.py"))) + [str(HERE / "export.py")]:
    lines = Path(f).read_text(encoding="utf-8").split("\n")
    for i, line in enumerate(lines):
        m = re.match(r'@router\.route\("(\w+)",\s*"([^"]+)"', line)
        if m:
            j = i + 1
            while not lines[j].lstrip().startswith(("def ", "async def ")):
                j += 1
            groups.setdefault(Path(f).name, []).append((m.group(1), m.group(2), lines[j].split("(")[0].replace("def ", "").strip()))
out = ["# Writer HTTP API (generated from the route table)\n",
       "Every route is under `/api`, loopback only, requires the session cookie and (for writes) the `X-SLAI-Writer` header, and answers `{ok, data}` or "
       "`{ok:false, error:{code,message,hint,details}}`. Regenerate with `python3 docs/gen_api.py`.\n"]
for name, items in groups.items():
    out.append(f"\n## {name}\n\n| Method | Path | Handler |\n|---|---|---|")
    out.extend(f"| {m} | `{p}` | `{fn}` |" for m, p, fn in items)
(HERE / "docs" / "API.md").write_text("\n".join(out) + "\n", encoding="utf-8")
print(sum(len(v) for v in groups.values()), "routes")
