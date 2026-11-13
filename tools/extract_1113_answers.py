from __future__ import annotations

import os
from pathlib import Path

import pymupdf as fitz


AI_ROOT = Path(os.environ["AI_ROOT"])
WORK = AI_ROOT / "Codex  Thing" / "素材" / "11月13日模考_识别结果"

JOBS = {
    "答案.raw.txt": Path(
        r"C:\Users\24832\Desktop\11月13日模考\行测（提升卷四）"
        r"\新【向尚教育】2027年寄宿制行测-提升卷（4）-答案版(1).pdf"
    ),
    "申论答案.raw.txt": Path(
        r"C:\Users\24832\Desktop\11月13日模考\申论（提升卷三）"
        r"\【向尚教育】2027年寄宿制-强化卷三（四川卷）-参考答案(1).pdf"
    ),
}


def main() -> None:
    output = WORK / "src"
    output.mkdir(parents=True, exist_ok=True)
    for name, source in JOBS.items():
        document = fitz.open(source)
        chunks = []
        for page_number, page in enumerate(document, 1):
            text = page.get_text("text", sort=True)
            chunks.append(f"===== PAGE {page_number} =====\n{text}")
        target = output / name
        target.write_text("\n".join(chunks), encoding="utf-8")
        print(f"{name}: pages={document.page_count} chars={sum(map(len, chunks))}")


if __name__ == "__main__":
    main()
