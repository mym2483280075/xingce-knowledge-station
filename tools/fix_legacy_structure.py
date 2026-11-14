#!/usr/bin/env python3
"""一次性修复历史页面中已确认的 HTML 结构缺口。"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUMMARY_PAGES = [
    ROOT / "sections" / "申论" / "概括题.html",
    ROOT / "sections" / "申论" / "公文写作.html",
    ROOT / "sections" / "申论" / "分析题.html",
    ROOT / "sections" / "申论" / "对策题.html",
]
DUPLICATE_HEAD_PAGES = [
    ROOT / "sections" / "每周模考" / "10月31日模考" / "成绩分析.html",
    ROOT / "sections" / "每周模考" / "10月31日模考" / "申论.html",
    ROOT / "sections" / "每周模考" / "10月31日模考" / "行测错题集合.html",
]


def main() -> None:
    changed = 0
    for path in SUMMARY_PAGES:
        text = path.read_text(encoding="utf-8")
        fixed, count = re.subn(
            r'(<summary>[^<]*<span class="hint">[^<]*)</summary>',
            r"\1</span></summary>",
            text,
        )
        if count:
            path.write_text(fixed, encoding="utf-8")
            changed += count
            print(f"{path.relative_to(ROOT)}: summary={count}")

    for path in DUPLICATE_HEAD_PAGES:
        text = path.read_text(encoding="utf-8")
        fixed, count = re.subn(r"</head>\s*</head>", "</head>", text, count=1)
        if count:
            path.write_text(fixed, encoding="utf-8")
            changed += count
            print(f"{path.relative_to(ROOT)}: duplicate-head=1")

    reading = ROOT / "sections" / "言语理解.html"
    text = reading.read_text(encoding="utf-8")
    start = text.index('id="yymod-7"')
    marker = '<section class="unit vocab" id="yyv-s-11"'
    end = text.index(marker, start)
    stray = text.find("  </main>", start, end)
    if stray >= 0:
        text = text[:stray] + text[stray + len("  </main>") :]
        reading.write_text(text, encoding="utf-8")
        changed += 1
        print(f"{reading.relative_to(ROOT)}: stray-main=1")

    data_page = ROOT / "sections" / "资料分析.html"
    text = data_page.read_text(encoding="utf-8")
    if "</head>" not in text:
        fixed, count = re.subn(r"(?m)^<body>$", "</head>\n<body>", text, count=1)
        if count:
            data_page.write_text(fixed, encoding="utf-8")
            changed += count
            print(f"{data_page.relative_to(ROOT)}: missing-head-close=1")

    print(f"fixed={changed}")


if __name__ == "__main__":
    main()
