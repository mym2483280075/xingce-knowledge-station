from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw


AI_ROOT = Path(os.environ["AI_ROOT"])
WORK = AI_ROOT / "Codex  Thing" / "素材" / "11月13日模考_识别结果"
SOURCE = WORK / "原图"
OUTPUT = WORK / "assets_raw"

CROPS = {
    "判断推理/q076.jpg": (22, (250, 400, 800, 640)),
    "判断推理/q077.jpg": (22, (260, 670, 790, 890)),
    "判断推理/q078.jpg": (22, (260, 920, 810, 1160)),
    "判断推理/q079.jpg": (22, (260, 1192, 810, 1425)),
    "判断推理/q080.jpg": (23, (270, 155, 800, 410)),
    "判断推理/q081.jpg": (23, (260, 445, 800, 685)),
    "判断推理/q082.jpg": (23, (250, 742, 870, 862)),
    "判断推理/q083.jpg": (23, (230, 985, 900, 1140)),
    "判断推理/q084.jpg": (23, (180, 1262, 930, 1440)),
    "判断推理/q085.jpg": (24, (170, 160, 880, 360)),
    "数量关系/q074-options.jpg": (21, (145, 530, 900, 1025)),
    "资料分析/q111-charts.jpg": (30, (165, 1082, 930, 1182)),
    "资料分析/mat116-chart.jpg": (31, (170, 535, 930, 1015)),
    "资料分析/mat121-table.jpg": (32, (210, 790, 880, 1475)),
    "资料分析/mat126-chart.jpg": (33, (190, 850, 910, 1270)),
}


def main() -> None:
    for relative, (page_number, box) in CROPS.items():
        source = SOURCE / f"p-{page_number:02d}.jpg"
        target = OUTPUT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as image:
            cropped = image.crop(box)
            if relative in {"判断推理/q082.jpg", "判断推理/q083.jpg", "判断推理/q084.jpg"}:
                ImageDraw.Draw(cropped).rectangle((0, 0, 48, 20), fill="white")
            if cropped.width < 900:
                factor = min(1.6, 1200 / cropped.width)
                cropped = cropped.resize(
                    (round(cropped.width * factor), round(cropped.height * factor)),
                    Image.Resampling.LANCZOS,
                )
            cropped.save(target, "JPEG", quality=92, subsampling=0)
        print(f"{relative}: {cropped.width}x{cropped.height}")


if __name__ == "__main__":
    main()
