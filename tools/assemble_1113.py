from __future__ import annotations

import json
import os
import re
from pathlib import Path

import numpy as np
from PIL import Image


AI_ROOT = Path(os.environ["AI_ROOT"])
WORK = AI_ROOT / "Codex  Thing" / "素材" / "11月13日模考_识别结果"
SOURCE = WORK / "原图"
OCR_DIR = WORK / "ocr_xc"

HEADER_TOKENS = ("向尚教育", "内部资料请勿外泄", "UpwardEducation")
DROP = {
    "向尚教育",
    "内部资料 请勿外泄",
    "内部资料请勿外泄",
    "Upward Education",
}
FOOT = re.compile(r"^《行政职业能力测验》题本")
QSTART = re.compile(r"^(\d{1,3})\s*[.、．,，]\s*(.*)$")
QNUM_ONLY = re.compile(r"^(\d{1,3})\s*[.、．]?$")
NOISE = [
    re.compile(r"^第[一二三四五六]部分"),
    re.compile(r"^[（(]共\s*\d+\s*题[）)]$"),
    re.compile(r"^根据题目要求[，,]?\s*在四个选项中选出一个最恰当的答案"),
    re.compile(r"^本部分包括表达与理解两方面的内容"),
    re.compile(r"^在这部分试题中[，,]?\s*每道题呈现一段表述数字关系的文字"),
    re.compile(r"^所给出的图、表、文字或综合性资料"),
    re.compile(r"^请开始答题[：:]?$"),
    re.compile(r"^[一二三四]、\s*(图形推理|定义判断|类比推理|逻辑判断)"),
    re.compile(r"^根据以下资料[，,]?\s*回答"),
    re.compile(r"^\d{3}\s*[~～—\-]\s*\d{3}\s*题基于以下题干"),
    re.compile(r".*部分结束[，,]?\s*请继续做.*"),
    re.compile(r"^※+.*(测验|测试).*结束.*※+$"),
    re.compile(r"^全部测验到此结束"),
]

BLANK_MARK = "________"
MIN_BLANK = 90
MAX_THICK = 7
MAX_BLANK = 340

STEM_OVERRIDES: dict[str, list[str]] = {}
OPT_OVERRIDES: dict[str, dict[str, str]] = {}
MISSING_MARKER_ANCHORS = {
    47: "数据与信息是国家和社会治理的基础。",
}


def is_noise(text: str) -> bool:
    text = text.strip()
    if not text or text in DROP or FOOT.match(text):
        return True
    if any(pattern.match(text) for pattern in NOISE):
        return True
    flat = re.sub(r"[\s\u3000_：:（）()]", "", text)
    if flat and len(flat) <= 5 and re.fullmatch(r"[A-D?？①②③④⑤⑥0-9]+", flat):
        return True
    return False


def is_header(text: str) -> bool:
    flat = re.sub(r"[\s\u3000]+", "", text)
    tokens = [re.sub(r"[\s\u3000]+", "", token) for token in HEADER_TOKENS]
    while flat:
        for token in tokens:
            if flat.startswith(token):
                flat = flat[len(token) :]
                break
        else:
            return False
    return True


def find_blanks(gray, y0: float, y1: float) -> list[tuple[int, int]]:
    y0 = max(0, int(y0) - 6)
    y1 = min(gray.shape[0], int(y1) + 14)
    if y1 - y0 < 3:
        return []
    band = (gray[y0:y1, :] < 170).astype(np.int8)
    blobs = []
    for yi in range(band.shape[0]):
        row = band[yi]
        diff = np.diff(np.concatenate(([0], row, [0])))
        starts = np.flatnonzero(diff == 1)
        ends = np.flatnonzero(diff == -1)
        for left, right in zip(starts, ends):
            if right - left < MIN_BLANK:
                continue
            grown = False
            for blob in blobs:
                if blob["y1"] == yi - 1 and min(blob["x1"], right) - max(
                    blob["x0"], left
                ) > 0.7 * min(blob["x1"] - blob["x0"], right - left):
                    blob["x0"] = min(blob["x0"], left)
                    blob["x1"] = max(blob["x1"], right)
                    blob["y1"] = yi
                    grown = True
                    break
            if not grown:
                blobs.append({"x0": left, "x1": right, "y0": yi, "y1": yi})
    return [
        (blob["x0"], blob["x1"])
        for blob in blobs
        if MIN_BLANK <= blob["x1"] - blob["x0"] <= MAX_BLANK
        and blob["y1"] - blob["y0"] + 1 <= MAX_THICK + 2
    ]


def merge_rows(pieces: list[dict]) -> list[dict]:
    items = sorted(pieces, key=lambda row: (row["top"], row["left"]))
    groups = []
    for row in items:
        for group in groups:
            overlap = min(row["bottom"], group["bottom"]) - max(
                row["top"], group["top"]
            )
            smaller = min(
                row["bottom"] - row["top"], group["bottom"] - group["top"]
            )
            if smaller > 0 and overlap / smaller >= 0.5:
                group["pieces"].append(row)
                group["top"] = min(group["top"], row["top"])
                group["bottom"] = max(group["bottom"], row["bottom"])
                break
        else:
            groups.append(
                {"top": row["top"], "bottom": row["bottom"], "pieces": [row]}
            )
    return groups


def render_row(group: dict, blanks: list[tuple[int, int]]) -> str:
    parts = sorted(group["pieces"], key=lambda row: row["left"])
    real_blanks = []
    for left, right in blanks:
        overlap = 0.0
        for part in parts:
            lo = max(left, part["left"])
            hi = min(right, part["right"])
            if hi > lo:
                overlap += hi - lo
        if (right - left) > 0 and overlap / (right - left) < 0.3:
            real_blanks.append((left, right))

    events = [("text", part["left"], part) for part in parts]
    events += [("blank", left, (left, right)) for left, right in real_blanks]
    events.sort(key=lambda event: event[1])
    text = ""
    right_edge = None
    for kind, _, payload in events:
        if kind == "blank":
            text += BLANK_MARK
            right_edge = payload[1]
            continue
        if right_edge is not None:
            gap = payload["left"] - right_edge
            if gap > 40:
                text += "\u3000"
            elif gap > 6:
                text += " "
        text += payload["text"]
        right_edge = payload["right"]
    return text


def load_rows() -> list[dict]:
    page_files = {
        path.name[: -len(".jpg")]: path for path in SOURCE.glob("p-*.jpg")
    }
    ocr_files = {
        path.name[: -len(".ocr.json")]: path
        for path in OCR_DIR.glob("p-*.ocr.json")
    }
    if set(page_files) != set(ocr_files):
        missing = sorted(set(page_files) - set(ocr_files))
        extra = sorted(set(ocr_files) - set(page_files))
        raise ValueError(f"OCR 页不齐：missing={missing}, extra={extra}")

    rows = []
    for name in sorted(page_files):
        page_number = int(name.split("-")[1])
        data = json.loads(ocr_files[name].read_text(encoding="utf-8"))
        pieces = []
        for line in data["lines"]:
            xs = [point[0] for point in line["box"]]
            ys = [point[1] for point in line["box"]]
            pieces.append(
                {
                    "text": line["text"].strip(),
                    "top": float(min(ys)),
                    "bottom": float(max(ys)),
                    "left": float(min(xs)),
                    "right": float(max(xs)),
                    "score": float(line.get("score", 1.0)),
                }
            )

        gray = np.array(Image.open(page_files[name]).convert("L"))
        for group in merge_rows(pieces):
            text = render_row(group, find_blanks(gray, group["top"], group["bottom"]))
            text = text.strip()
            plain = text.replace(BLANK_MARK, "")
            if is_noise(text) or is_header(plain):
                continue
            rows.append(
                {
                    "text": text,
                    "top": group["top"],
                    "bottom": group["bottom"],
                    "left": min(part["left"] for part in group["pieces"]),
                    "right": max(part["right"] for part in group["pieces"]),
                    "score": min(part["score"] for part in group["pieces"]),
                    "page": page_number,
                }
            )
    return rows


def find_question_markers(rows: list[dict]) -> list[tuple[int, int]]:
    expected = 1
    markers = []
    for index, row in enumerate(rows):
        if row["page"] < 5:
            continue
        text = row["text"]
        match = QSTART.match(text)
        number = None
        if match and row["left"] < 260 and int(match.group(1)) == expected:
            number = expected
        elif (
            QNUM_ONLY.match(text)
            and row["left"] < 260
            and int(QNUM_ONLY.match(text).group(1)) == expected
        ):
            number = expected
        if number is not None:
            markers.append((index, number))
            expected = number + 1
    return markers


def inject_missing_markers(rows: list[dict]) -> list[dict]:
    for number, anchor in MISSING_MARKER_ANCHORS.items():
        matches = [index for index, row in enumerate(rows) if anchor in row["text"]]
        if len(matches) != 1:
            raise ValueError(f"第 {number} 题锚点命中 {len(matches)} 次：{anchor}")
        index = matches[0]
        marker = dict(rows[index])
        marker["text"] = f"{number}."
        rows.insert(index, marker)
    return rows


def extract_options(rows: list[dict]) -> tuple[list[str], list[tuple[str, str]]]:
    stem = []
    options: dict[str, list[str]] = {}
    current = None
    start_option = re.compile(r"(?:^|(?<=[\s\u3000]))([A-D])\s*[.、．]\s*")
    for row in rows:
        text = row["text"].strip()
        matches = list(start_option.finditer(text))
        if matches:
            prefix = text[: matches[0].start()].strip()
            if prefix and current is None:
                stem.append(prefix)
            for index, match in enumerate(matches):
                letter = match.group(1)
                end = (
                    matches[index + 1].start()
                    if index + 1 < len(matches)
                    else len(text)
                )
                current = letter
                options.setdefault(letter, []).append(
                    text[match.end() : end].strip()
                )
        elif current is not None:
            options[current].append(text)
        else:
            stem.append(text)
    return stem, [
        (letter, "".join(options.get(letter, [])))
        for letter in "ABCD"
        if letter in options
    ]


def main() -> None:
    rows = inject_missing_markers(load_rows())
    markers = find_question_markers(rows)
    questions = {}
    for marker_index, (row_index, number) in enumerate(markers):
        end = (
            markers[marker_index + 1][0]
            if marker_index + 1 < len(markers)
            else len(rows)
        )
        block = [dict(row) for row in rows[row_index:end]]
        match = QSTART.match(block[0]["text"])
        block[0]["text"] = match.group(2) if match and match.group(2) else ""
        stem, options = extract_options(block)
        key = str(number)
        if key in STEM_OVERRIDES:
            stem = STEM_OVERRIDES[key]
        if key in OPT_OVERRIDES:
            options = [
                (letter, OPT_OVERRIDES[key][letter])
                for letter in "ABCD"
                if letter in OPT_OVERRIDES[key]
            ]
        questions[key] = {
            "number": number,
            "stem": stem,
            "options": options,
            "pages": sorted(set(row["page"] for row in block)),
            "lowConfidence": sum(row["score"] < 0.8 for row in block),
        }

    missing = [number for number in range(1, 131) if str(number) not in questions]
    if missing:
        raise ValueError(f"题号缺失：{missing}")

    no_options = [
        number
        for number in range(1, 131)
        if len(questions[str(number)]["options"]) != 4
    ]
    (WORK / "src" / "questions.raw.json").write_text(
        json.dumps(questions, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"questions={len(questions)} pages={max(row['page'] for row in rows)}")
    print(f"no-option-count={no_options}")
    for number in no_options:
        print(
            number,
            questions[str(number)]["pages"],
            questions[str(number)]["stem"][:2],
        )


if __name__ == "__main__":
    main()
