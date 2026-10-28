from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


AI_ROOT = Path(os.environ["AI_ROOT"])
MATERIALS = AI_ROOT / "Codex  Thing" / "素材"
JOBS = [
    MATERIALS / "提升卷二（10月28日）_识别结果",
    MATERIALS / "提升卷二（10月28日）_申论识别结果",
]


def contact_font(size: int) -> ImageFont.ImageFont:
    windows_dir = os.environ.get("WINDIR")
    if windows_dir:
        candidate = Path(windows_dir) / "Fonts" / "msyh.ttc"
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def make_contact(root: Path) -> Path:
    images = sorted((root / "原图").glob("p*.jpg"))
    if not images:
        raise FileNotFoundError(root / "原图")

    thumb_width = 360
    margin = 20
    label_height = 32
    columns = 5
    rows = (len(images) + columns - 1) // columns
    sample = Image.open(images[0])
    thumb_height = round(sample.height * thumb_width / sample.width)
    cell_height = thumb_height + label_height
    canvas = Image.new(
        "RGB",
        (
            margin + columns * (thumb_width + margin),
            margin + rows * (cell_height + margin),
        ),
        "#d8d8d8",
    )
    draw = ImageDraw.Draw(canvas)
    font = contact_font(22)

    for index, path in enumerate(images):
        image = Image.open(path).convert("RGB")
        image.thumbnail((thumb_width, thumb_height), Image.Resampling.LANCZOS)
        column = index % columns
        row = index // columns
        x = margin + column * (thumb_width + margin)
        y = margin + row * (cell_height + margin)
        canvas.paste(image, (x, y))
        draw.text((x + 8, y + thumb_height + 3), path.stem, fill="#222", font=font)

    output = root / "_check" / "contact.jpg"
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, quality=88)
    print(f"{output} size={canvas.size} pages={len(images)}")
    return output


def main() -> None:
    for root in JOBS:
        make_contact(root)


if __name__ == "__main__":
    main()
