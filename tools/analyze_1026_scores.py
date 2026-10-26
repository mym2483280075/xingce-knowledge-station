from __future__ import annotations

import argparse
import csv
import itertools
import json
import math
import re
import statistics
from pathlib import Path

import cv2
import numpy as np


HEADERS = [
    "准考证号",
    "姓名",
    "班级",
    "总分排名",
    "总分成绩",
    "申论排名",
    "申论成绩",
    "行测排名",
    "行测成绩",
    "政治理论",
    "常识判断",
    "言语理解",
    "数量关系",
    "图形推理",
    "定义判断",
    "类比推理",
    "逻辑判断",
    "资料分析",
]

MODULE_SPECS = [
    ("政治理论", 8.0, 0.8, 10),
    ("常识判断", 8.0, 0.8, 10),
    ("言语理解", 24.0, 0.8, 30),
    ("数量关系", 9.0, 0.9, 10),
    ("图形推理", 9.0, 0.9, 10),
    ("定义判断", 8.0, 0.8, 10),
    ("类比推理", 7.0, 0.7, 10),
    ("逻辑判断", 9.0, 0.9, 10),
    ("资料分析", 18.0, 0.9, 20),
]

# 原图竖向网格线，按表头顺序从左到右排列。
COLS = [12, 103, 175, 224, 289, 354, 420, 485, 551, 616, 690, 763, 837, 910, 984, 1058, 1131, 1205, 1278]

def imread(path: Path) -> np.ndarray:
    image = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise SystemExit(f"读不到图片：{path}")
    return image


def cell_crop(cell: np.ndarray, pad: int = 4, target_h: int = 56) -> np.ndarray | None:
    if cell.size == 0:
        return None
    gray = cv2.cvtColor(cell, cv2.COLOR_BGR2GRAY)
    work = gray.astype(np.float32)
    background = float(np.median(work))
    mask = (np.abs(work - background) > 42).astype(np.uint8)
    height, width = mask.shape
    margin = max(1, min(height, width) // 10)
    mask[:margin, :] = 0
    mask[-margin:, :] = 0
    mask[:, :margin] = 0
    mask[:, -margin:] = 0
    if int(mask.sum()) < 8:
        return None
    ys, xs = np.where(mask > 0)
    y0, y1 = max(0, int(ys.min()) - pad), min(height, int(ys.max()) + pad + 1)
    x0, x1 = max(0, int(xs.min()) - pad), min(width, int(xs.max()) + pad + 1)
    sub = work[y0:y1, x0:x1]
    text_dark = float(sub[mask[y0:y1, x0:x1] > 0].mean()) < background
    normalized = sub if text_dark else 255.0 - sub
    low, high = np.percentile(normalized, 2), np.percentile(normalized, 98)
    if high - low < 1:
        return None
    output = np.clip((normalized - low) * (255.0 / (high - low)), 0, 255).astype(np.uint8)
    if output.shape[0] < target_h:
        scale = target_h / output.shape[0]
        output = cv2.resize(output, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return cv2.cvtColor(output, cv2.COLOR_GRAY2BGR)


def build_engine() -> object:
    from rapidocr_onnxruntime import RapidOCR

    return RapidOCR(
        intra_op_num_threads=12,
        rec_batch_num=32,
        max_side_len=100000,
        min_side_len=1,
        min_height=6,
    )


def recognize(engine: object, crops: list[np.ndarray]) -> list[str]:
    results: list[str] = []
    recognizer = engine.text_rec
    for offset in range(0, len(crops), 256):
        chunk = crops[offset : offset + 256]
        output, _ = recognizer(chunk)
        results.extend([(text or "").strip() for text, _ in output])
    return results


def detect_row_edges(image: np.ndarray) -> list[int]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    table = gray[:, COLS[0] : COLS[-1]]
    gap = 2
    above = np.abs(table - np.vstack([np.repeat(table[:1], gap, axis=0), table[:-gap]]))
    below = np.abs(table - np.vstack([table[gap:], np.repeat(table[-1:], gap, axis=0)]))
    scores = ((above > 15) & (below > 15)).mean(axis=1)
    candidates: list[int] = []
    for y in range(1, len(scores) - 1):
        if scores[y] >= 0.50 and scores[y] == scores[max(0, y - 5) : y + 6].max():
            candidates.append(y)
    candidates = [y for y in candidates if y >= 81]
    desired_last = image.shape[0] - 1
    if not candidates or abs(candidates[-1] - desired_last) > 30:
        candidates.append(desired_last)
    return candidates


def extract(image: np.ndarray) -> list[list[str]]:
    row_edges = detect_row_edges(image)
    row_count = len(row_edges) - 1
    cells: list[list[str]] = [[] for _ in range(row_count)]
    crops: list[np.ndarray] = []
    coordinates: list[tuple[int, int]] = []

    for row_index, (top, bottom) in enumerate(zip(row_edges, row_edges[1:])):
        for col_index, (left, right) in enumerate(zip(COLS, COLS[1:])):
            cell = image[top + 2 : bottom - 1, left + 2 : right - 1]
            crop = cell_crop(cell)
            if crop is not None:
                crops.append(crop)
                coordinates.append((row_index, col_index))

    engine = build_engine()
    for (row_index, col_index), text in zip(coordinates, recognize(engine, crops)):
        while len(cells[row_index]) <= col_index:
            cells[row_index].append("")
        cells[row_index][col_index] = text
    return [row + [""] * (len(HEADERS) - len(row)) for row in cells]


def normalize_number(value: str) -> float | None:
    value = (
        value.strip()
        .translate(str.maketrans({"－": "-", "﹣": "-", "．": ".", "。": ".", "，": ""}))
        .replace("O", "0")
        .replace("o", "0")
        .replace("Q", "0")
        .replace("D", "0")
        .replace("l", "1")
        .replace("I", "1")
        .replace("i", "1")
        .replace("|", "1")
        .replace("S", "5")
        .replace("B", "8")
    )
    if not value or "缺考" in value:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", value)
    if not match:
        return None
    return float(match.group(0))


def compact_digits(value: str) -> str:
    return re.sub(r"\D", "", value)


def edit_distance(left: str, right: str) -> int:
    if left == right:
        return 0
    previous = list(range(len(right) + 1))
    for left_index, left_char in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_char in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1] + (left_char != right_char),
                )
            )
        previous = current
    return previous[-1]


def allowed_module_values(maximum: float, step: float) -> list[float]:
    return [round(step * index, 1) for index in range(round(maximum / step) + 1)]


def module_candidates(raw: str, maximum: float, step: float) -> list[tuple[float, float]]:
    values = allowed_module_values(maximum, step)
    raw_digits = compact_digits(raw)
    raw_number = normalize_number(raw)
    scored: list[tuple[float, float]] = []
    for value in values:
        value_text = f"{value:.1f}".rstrip("0").rstrip(".")
        value_digits = compact_digits(value_text)
        if raw_number is not None and abs(raw_number - value) <= 0.011:
            cost = 0.0
        else:
            distance = edit_distance(raw_digits, value_digits)
            if distance > 1:
                continue
            cost = float(distance)
        scored.append((cost, value))
    if not scored:
        for value in values:
            value_text = f"{value:.1f}".rstrip("0").rstrip(".")
            scored.append((float(edit_distance(raw_digits, compact_digits(value_text)) + 1), value))
    scored.sort()
    best = scored[0][0]
    return [(cost, value) for cost, value in scored if cost <= best + 0.001]


def repair_records(rows: list[list[str]]) -> list[dict[str, float | str | None]]:
    repaired: list[dict[str, float | str | None]] = []
    for row_number, row in enumerate(rows, start=1):
        module_options: list[list[tuple[float, float]]] = []
        for (name, maximum, step, _), raw in zip(MODULE_SPECS, row[9:18]):
            module_options.append(module_candidates(raw, maximum, step))

        parsed_xingce = normalize_number(row[8])
        if parsed_xingce is not None and not 0 <= parsed_xingce <= 100:
            parsed_xingce = None
        best_choice: tuple[float, list[tuple[float, float]]] | None = None
        for choice in itertools.product(*module_options):
            values = [value for _, value in choice]
            total = round(sum(values), 1)
            penalty = sum(cost for cost, _ in choice) * 0.01
            if parsed_xingce is not None:
                penalty += abs(total - parsed_xingce)
            if best_choice is None or penalty < best_choice[0]:
                best_choice = (penalty, choice)
        assert best_choice is not None
        modules = [value for _, value in best_choice[1]]
        xingce = round(sum(modules), 1)

        parsed_shenlun = normalize_number(row[6])
        parsed_total = normalize_number(row[4])
        if parsed_shenlun is not None and not 0 <= parsed_shenlun <= 100:
            parsed_shenlun = None
        if parsed_total is not None and not 0 <= parsed_total <= 200:
            parsed_total = None

        if parsed_shenlun is None and parsed_total is not None:
            shenlun = round(parsed_total - xingce, 1)
            if not 0 <= shenlun <= 100:
                shenlun = 0.0
        else:
            shenlun = round(parsed_shenlun or 0.0, 1)
        total = round(shenlun + xingce, 1)

        record: dict[str, float | str | None] = {
            "_row": float(row_number),
            "班级": "308",
            "总分排名": normalize_number(row[3]),
            "总分成绩": total,
            "申论排名": normalize_number(row[5]),
            "申论成绩": shenlun,
            "行测排名": normalize_number(row[7]),
            "行测成绩": xingce,
        }
        for (name, _, _, _), value in zip(MODULE_SPECS, modules):
            record[name] = value
        repaired.append(record)
    return repaired


def metric_summary(values: list[float]) -> dict[str, float | int]:
    ordered = sorted(values)
    if not ordered:
        return {"n": 0}

    def percentile(fraction: float) -> float:
        position = (len(ordered) - 1) * fraction
        lower = math.floor(position)
        upper = math.ceil(position)
        if lower == upper:
            return ordered[lower]
        return ordered[lower] * (upper - position) + ordered[upper] * (position - lower)

    return {
        "n": len(ordered),
        "mean": round(statistics.fmean(ordered), 2),
        "median": round(statistics.median(ordered), 2),
        "p25": round(percentile(0.25), 2),
        "p75": round(percentile(0.75), 2),
        "min": round(min(ordered), 2),
        "max": round(max(ordered), 2),
        "sd": round(statistics.pstdev(ordered), 2),
    }


def competition_rank(values: list[float], target: float) -> int:
    return 1 + sum(1 for value in values if value > target + 0.001)


def analyze_records(records: list[dict[str, float | str | None]]) -> dict[str, object]:
    total_values = [
        float(record["总分成绩"])
        for record in records
        if float(record["总分成绩"]) > 0
        and float(record["申论成绩"]) > 0
        and float(record["行测成绩"]) > 0
    ]
    shenlun_values = [float(record["申论成绩"]) for record in records if float(record["申论成绩"]) > 0]
    xingce_values = [float(record["行测成绩"]) for record in records if float(record["行测成绩"]) > 0]
    xingce_records = [record for record in records if float(record["行测成绩"]) > 0]

    target = next(
        record
        for record in records
        if float(record["总分成绩"]) == 121.3
        and float(record["申论成绩"]) == 63.0
        and float(record["行测成绩"]) == 58.3
    )
    target_total = float(target["总分成绩"])
    target_shenlun = float(target["申论成绩"])
    target_xingce = float(target["行测成绩"])

    module_rows: list[dict[str, float | int | str]] = []
    for name, maximum, step, questions in MODULE_SPECS:
        score = float(target[name])
        values = [float(record[name]) for record in xingce_records]
        summary = metric_summary(values)
        module_rows.append(
            {
                "name": name,
                "score": score,
                "maximum": maximum,
                "rate": round(score / maximum * 100, 1),
                "questions": questions,
                "correct_questions": round(score / step),
                "class_mean": summary["mean"],
                "class_median": summary["median"],
                "class_rank": competition_rank(values, score),
                "class_n": summary["n"],
                "delta_mean": round(score - float(summary["mean"]), 2),
            }
        )

    total_distribution: list[dict[str, float | int | str]] = []
    for label, low, high in [
        ("90 分以下", 0, 90),
        ("90–99.9", 90, 100),
        ("100–109.9", 100, 110),
        ("110–119.9", 110, 120),
        ("120–129.9", 120, 130),
        ("130–139.9", 130, 140),
        ("140 分以上", 140, 200.01),
    ]:
        count = sum(1 for value in total_values if low <= value < high)
        total_distribution.append(
            {
                "label": label,
                "count": count,
                "rate": round(count / len(total_values) * 100, 1),
                "contains_target": low <= target_total < high,
            }
        )

    return {
        "source_rows": len(records),
        "class": 308,
        "target": {
            "total": target_total,
            "shenlun": target_shenlun,
            "xingce": target_xingce,
            "total_grade_rank": int(target["总分排名"]),
            "shenlun_grade_rank": int(target["申论排名"]),
            "xingce_grade_rank": int(target["行测排名"]),
            "total_class_rank": competition_rank(total_values, target_total),
            "total_class_n": len(total_values),
            "shenlun_class_rank": competition_rank(shenlun_values, target_shenlun),
            "shenlun_class_n": len(shenlun_values),
            "xingce_class_rank": competition_rank(xingce_values, target_xingce),
            "xingce_class_n": len(xingce_values),
            "right_questions": sum(int(row["correct_questions"]) for row in module_rows),
            "right_rate": round(target_xingce / 100 * 100, 1),
        },
        "total": metric_summary(total_values),
        "shenlun": metric_summary(shenlun_values),
        "xingce": metric_summary(xingce_values),
        "modules": module_rows,
        "total_distribution": total_distribution,
    }


def validate(rows: list[list[str]]) -> dict[str, object]:
    records: list[dict[str, object]] = []
    errors: list[dict[str, object]] = []
    for row_number, row in enumerate(rows, start=1):
        numbers = [normalize_number(value) for value in row[3:]]
        record = dict(zip(HEADERS, row))
        record["_row"] = row_number
        record["_numeric"] = dict(zip(HEADERS[3:], numbers))
        records.append(record)
        values = record["_numeric"]
        total = values["总分成绩"]
        shenlun = values["申论成绩"]
        xingce = values["行测成绩"]
        modules = [values[name] for name in HEADERS[9:]]
        if total is not None and shenlun is not None and xingce is not None:
            if abs(total - (shenlun + xingce)) > 0.011:
                errors.append({"type": "总分勾稽", "row": row_number, "values": [total, shenlun, xingce]})
        if xingce is not None and all(value is not None for value in modules):
            if abs(xingce - sum(modules)) > 0.011:
                errors.append({"type": "行测模块勾稽", "row": row_number, "values": [xingce, modules]})
        if row[2].strip() not in {"308", ""}:
            errors.append({"type": "班级异常", "row": row_number, "value": row[2]})
        if total is None and not all(value in {"", "缺考", "0", "0", "0.0"} for value in row[3:]):
            errors.append({"type": "缺考异常", "row": row_number, "value": row[3:]})

    non_missing_ranks = [
        int(record["_numeric"]["总分排名"])
        for record in records
        if record["_numeric"]["总分排名"] is not None
    ]
    if any(right < left for left, right in zip(non_missing_ranks, non_missing_ranks[1:])):
        errors.append({"type": "总分排名非升序", "values": non_missing_ranks})

    target_candidates = [
        record
        for record in records
        if record["_numeric"]["总分成绩"] == 121.3
        and record["_numeric"]["申论成绩"] == 63.0
        and record["_numeric"]["行测成绩"] == 58.3
    ]

    return {
        "headers": HEADERS,
        "row_count": len(rows),
        "errors": errors,
        "target_candidates": target_candidates,
        "records": records,
        "raw_rows": rows,
        "column_edges": COLS,
        "row_edges": [len(rows), "detected_from_image"],
    }


def write_outputs(result: dict[str, object], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    with (output_dir / "scores_raw.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(HEADERS)
        writer.writerows(result["raw_rows"])
    with (output_dir / "scores_validation.json").open("w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    clean_records = result["clean_records"]
    with (output_dir / "scores_clean.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        fields = ["_row", "班级", "总分排名", "总分成绩", "申论排名", "申论成绩", "行测排名", "行测成绩"] + [
            spec[0] for spec in MODULE_SPECS
        ]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(clean_records)
    with (output_dir / "analysis_summary.json").open("w", encoding="utf-8") as handle:
        json.dump(result["summary"], handle, ensure_ascii=False, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(description="按固定网格识别 10月26日成绩表并做数值勾稽")
    parser.add_argument("image", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    rows = extract(imread(args.image))
    result = validate(rows)
    result["clean_records"] = repair_records(rows)
    result["summary"] = analyze_records(result["clean_records"])
    write_outputs(result, args.out)
    print(
        json.dumps(
            {
                "rows": result["row_count"],
                "errors": len(result["errors"]),
                "clean_rows": len(result["clean_records"]),
                "output": str(args.out),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
