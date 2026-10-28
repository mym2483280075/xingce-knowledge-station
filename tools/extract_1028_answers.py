from __future__ import annotations

import os
from pathlib import Path

import pypdf
import pypdfium2 as pdfium


AI_ROOT = Path(os.environ["AI_ROOT"])
MATERIALS = AI_ROOT / "Codex  Thing" / "素材"
JOBS = [
    (
        MATERIALS / "提升卷二（10月28日）_识别结果",
        "行测答案版.pdf",
        "行测答案.raw.txt",
    ),
    (
        MATERIALS / "提升卷二（10月28日）_申论识别结果",
        "申论参考答案.pdf",
        "申论答案.raw.txt",
    ),
]


def extract_job(base: Path, pdf_name: str, text_name: str) -> None:
    source = base / pdf_name
    src_dir = base / "src"
    page_dir = base / "_check" / "页图"
    src_dir.mkdir(parents=True, exist_ok=True)
    page_dir.mkdir(parents=True, exist_ok=True)

    reader = pypdf.PdfReader(str(source))
    chunks: list[str] = []
    for number, page in enumerate(reader.pages, 1):
        text = page.extract_text() or ""
        chunks.append(f"===== PAGE {number} =====\n{text}")

    text_path = src_dir / text_name
    text_path.write_text("\n".join(chunks), encoding="utf-8")

    pdf = pdfium.PdfDocument(str(source))
    for number, page in enumerate(pdf, 1):
        image = page.render(scale=200 / 72).to_pil()
        image.save(page_dir / f"p{number:02d}.png")

    print(
        f"{pdf_name}: pages={len(reader.pages)}, "
        f"chars={sum(len(chunk) for chunk in chunks)}, text={text_path}"
    )


def main() -> None:
    for base, pdf_name, text_name in JOBS:
        extract_job(base, pdf_name, text_name)


if __name__ == "__main__":
    main()
