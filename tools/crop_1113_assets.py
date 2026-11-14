from __future__ import annotations

import os
from pathlib import Path

from PIL import Image


AI_ROOT = Path(os.environ["AI_ROOT"])
WORK = AI_ROOT / "Codex  Thing" / "素材" / "11月13日模考_识别结果"
SOURCE = WORK / "原图"
OUTPUT = WORK / "assets_raw"

CROPS = {
    "判断推理/q076.png": (22, (140, 360, 1020, 680)),
    "判断推理/q077.png": (22, (140, 675, 1020, 925)),
    "判断推理/q078.png": (22, (140, 920, 1020, 1175)),
    "判断推理/q079.png": (22, (140, 1175, 1020, 1450)),
    "判断推理/q080.png": (23, (140, 135, 1020, 435)),
    "判断推理/q081.png": (23, (140, 420, 1020, 710)),
    "判断推理/q082.png": (23, (140, 690, 1020, 935)),
    "判断推理/q083.png": (23, (140, 925, 1020, 1190)),
    "判断推理/q084.png": (23, (140, 1180, 1020, 1480)),
    "判断推理/q085.png": (24, (120, 120, 1020, 400)),
    "数量关系/q074-options.png": (21, (145, 530, 900, 1025)),
    "资料分析/q111-charts.png": (30, (165, 1082, 930, 1182)),
    "资料分析/mat116-chart.png": (31, (170, 535, 930, 1015)),
    "资料分析/mat121-table.png": (32, (210, 790, 880, 1475)),
    "资料分析/mat126-chart.png": (33, (190, 850, 910, 1270)),
}


def main() -> None:
    for relative, (page_number, box) in CROPS.items():
        source = SOURCE / f"p-{page_number:02d}.jpg"
        target = OUTPUT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as image:
            cropped = image.crop(box)
            cropped.save(target, "PNG")
        print(f"{relative}: {cropped.width}x{cropped.height}")


if __name__ == "__main__":
    main()
