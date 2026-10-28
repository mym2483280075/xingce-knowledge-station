from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


AI_ROOT = Path(os.environ["AI_ROOT"])
WORK = AI_ROOT / "Codex  Thing" / "素材" / "提升卷二（10月28日）_识别结果"
SOURCE = WORK / "原图"
OUTPUT = WORK / "assets_raw"
CONTACT = WORK / "_check" / "crop_contact.jpg"

# page, left, top, right, bottom, relative output path
BOXES = [
    (18, 400, 680, 1820, 1130, "判断推理/q076.jpg"),
    (18, 400, 1190, 1820, 1760, "判断推理/q077.jpg"),
    (18, 400, 1820, 1820, 2410, "判断推理/q078.jpg"),
    (19, 390, 260, 1800, 790, "判断推理/q079.jpg"),
    (19, 250, 820, 1800, 1370, "判断推理/q080.jpg"),
    (19, 250, 1410, 1800, 1950, "判断推理/q081.jpg"),
    (19, 100, 1965, 1800, 2320, "判断推理/q082.jpg"),
    (20, 320, 250, 1810, 790, "判断推理/q083.jpg"),
    (20, 320, 810, 1790, 1230, "判断推理/q084.jpg"),
    (20, 320, 1280, 1780, 1910, "判断推理/q085.jpg"),
    (22, 100, 1340, 1950, 1690, "判断推理/q091.jpg"),
    (28, 180, 840, 2110, 1540, "资料分析/q114-charts.jpg"),
    (28, 150, 2020, 2070, 2840, "资料分析/mat116-chart.jpg"),
    (29, 260, 170, 1650, 760, "资料分析/mat116-table.jpg"),
    (30, 330, 230, 1750, 1610, "资料分析/mat121-chart-table.jpg"),
    (31, 300, 570, 1780, 1320, "资料分析/mat126-table.jpg"),
]


def contact_font(size: int) -> ImageFont.ImageFont:
    windows_dir = os.environ.get("WINDIR")
    candidates = []
    if windows_dir:
        candidates.append(Path(windows_dir) / "Fonts" / "msyh.ttc")
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def main() -> None:
    pages = sorted(SOURCE.glob("p*.jpg"))
    if len(pages) != 31:
        raise ValueError(f"原图应为 31 页，实际 {len(pages)} 页")

    images = {}
    thumbs = []
    font = contact_font(20)
    for page, left, top, right, bottom, relative in BOXES:
        if page not in images:
            images[page] = Image.open(pages[page - 1]).convert("RGB")
        image = images[page]
        crop = image.crop((left, top, min(right, image.width), min(bottom, image.height)))
        target = OUTPUT / Path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        crop.save(target, quality=96)
        print(f"{relative:34s} p{page:02d} {crop.width}x{crop.height}")

        thumb = crop.copy()
        thumb.thumbnail((340, 250), Image.Resampling.LANCZOS)
        card = Image.new("RGB", (380, 300), "white")
        card.paste(thumb, ((380 - thumb.width) // 2, 8))
        ImageDraw.Draw(card).text((8, 270), relative, fill="#222", font=font)
        thumbs.append(card)

    columns = 4
    rows = (len(thumbs) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * 380, rows * 300), "#d8d8d8")
    for index, card in enumerate(thumbs):
        sheet.paste(card, ((index % columns) * 380, (index // columns) * 300))
    CONTACT.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(CONTACT, quality=92)
    print(f"contact={CONTACT}")


if __name__ == "__main__":
    main()
