from __future__ import annotations

import argparse
import csv
import json
import re
import statistics
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
SITE = TOOLS.parent
sys.path.insert(0, str(TOOLS))

import analyze_1026_scores as table
from data_1113 import USER_RESPONSE_RAW


MODULE_SPECS = [
    ("政治理论", 16.0, 0.8, 20, 1, 20),
    ("常识判断", 9.0, 0.6, 15, 21, 35),
    ("言语理解", 21.0, 0.7, 30, 36, 65),
    ("数量关系", 9.0, 0.9, 10, 66, 75),
    ("图形推理", 7.0, 0.7, 10, 76, 85),
    ("定义判断", 8.0, 0.8, 10, 86, 95),
    ("类比推理", 4.0, 0.8, 5, 96, 100),
    ("逻辑判断", 8.0, 0.8, 10, 101, 110),
    ("资料分析", 18.0, 0.9, 20, 111, 130),
]

TARGET = {"total": 130.2, "shenlun": 62.5, "xingce": 67.7}
SHENLUN_ITEMS = [
    {"number": 1, "name": "概括题", "score": 5.0, "maximum": 10.0},
    {"number": 2, "name": "分析题", "score": 10.0, "maximum": 15.0},
    {"number": 3, "name": "公文写作", "score": 12.0, "maximum": 20.0},
    {"number": 4, "name": "对策题", "score": 14.5, "maximum": 20.0},
    {"number": 5, "name": "大作文", "score": 21.0, "maximum": 35.0},
]
PREVIOUS = {
    "total": 135.4,
    "shenlun": 71.5,
    "xingce": 63.9,
    "政治理论": 9.6,
    "常识判断": 4.8,
    "言语理解": 13.3,
    "数量关系": 2.7,
    "图形推理": 4.9,
    "定义判断": 7.2,
    "类比推理": 3.2,
    "逻辑判断": 5.6,
    "资料分析": 12.6,
}

# analyze_1026_scores holds the extraction grid and repair routines as reusable
# helpers. Its module weights differ, so supply the 11月13日 weights explicitly.
table.COLS = [
    0,
    120,
    196,
    260,
    331,
    399,
    468,
    537,
    606,
    675,
    742,
    809,
    876,
    945,
    1011,
    1078,
    1145,
    1212,
    1280,
]
table.MODULE_SPECS = [(name, maximum, step, questions) for name, maximum, step, questions, _, _ in MODULE_SPECS]


def parse_user_answers(raw: str) -> dict[int, str]:
    answers: dict[int, str] = {}
    for part in re.split(r"[,，]", raw):
        part = part.strip().lower()
        if not part:
            continue
        single = re.fullmatch(r"(\d+)([a-d])", part)
        if single:
            numbers = [int(single.group(1))]
            letter = single.group(2).upper()
        else:
            span = re.fullmatch(r"(\d+)到(\d+)均([a-d])", part)
            if not span:
                raise ValueError(f"无法识别作答片段：{part}")
            numbers = list(range(int(span.group(1)), int(span.group(2)) + 1))
            letter = span.group(3).upper()
        for number in numbers:
            if not 1 <= number <= 130 or number in answers:
                raise ValueError(f"作答题号异常：{number}")
            answers[number] = letter
    return answers


def expected_signature(authored_answers: dict[str, dict[str, str]]) -> dict[str, object]:
    user_answers = parse_user_answers(USER_RESPONSE_RAW)
    wrong = sorted(
        number
        for number, answer in user_answers.items()
        if answer != authored_answers[str(number)]["answer"]
    )
    lucky = sorted(
        number
        for number, answer in user_answers.items()
        if answer == authored_answers[str(number)]["answer"]
    )
    modules: list[dict[str, object]] = []
    for name, maximum, step, questions, start, end in MODULE_SPECS:
        wrong_in_module = sum(start <= number <= end for number in wrong)
        lucky_in_module = sum(start <= number <= end for number in lucky)
        correct = questions - wrong_in_module
        modules.append(
            {
                "name": name,
                "correct": correct,
                "questions": questions,
                "score": round(correct * step, 1),
                "wrong": wrong_in_module,
                "lucky": lucky_in_module,
            }
        )
    return {
        "listed": len(user_answers),
        "wrong": wrong,
        "lucky": lucky,
        "modules": modules,
        "xingce": round(sum(float(module["score"]) for module in modules), 1),
    }


def metric_summary(values: list[float]) -> dict[str, float | int]:
    if not values:
        return {"n": 0}
    ordered = sorted(values)

    def percentile(fraction: float) -> float:
        position = (len(ordered) - 1) * fraction
        lower = int(position)
        upper = min(lower + 1, len(ordered) - 1)
        return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)

    return {
        "n": len(ordered),
        "mean": round(statistics.fmean(ordered), 2),
        "median": round(statistics.median(ordered), 2),
        "p25": round(percentile(0.25), 2),
        "p75": round(percentile(0.75), 2),
        "min": round(min(ordered), 2),
        "max": round(max(ordered), 2),
    }


def competition_rank(values: list[float], target: float) -> int:
    return 1 + sum(value > target for value in values)


def analyze_shenlun() -> dict[str, object]:
    items = []
    for item in SHENLUN_ITEMS:
        score = float(item["score"])
        maximum = float(item["maximum"])
        items.append(
            {
                **item,
                "rate": round(score / maximum * 100, 1),
                "lost": round(maximum - score, 1),
            }
        )
    total = round(sum(float(item["score"]) for item in items), 1)
    if total != TARGET["shenlun"]:
        raise ValueError(f"申论分项合计 {total} 与正式总分不一致")
    small = round(sum(float(item["score"]) for item in items[:4]), 1)
    small_max = round(sum(float(item["maximum"]) for item in items[:4]), 1)
    essay = float(items[4]["score"])
    essay_max = float(items[4]["maximum"])
    ordered_by_rate = sorted(items, key=lambda item: (-float(item["rate"]), int(item["number"])))
    ordered_by_loss = sorted(items, key=lambda item: (-float(item["lost"]), int(item["number"])))
    return {
        "total": total,
        "items": items,
        "small_total": small,
        "small_maximum": small_max,
        "small_rate": round(small / small_max * 100, 1),
        "essay_score": essay,
        "essay_maximum": essay_max,
        "essay_rate": round(essay / essay_max * 100, 1),
        "ordered_by_rate": [item["name"] for item in ordered_by_rate],
        "ordered_by_loss": [item["name"] for item in ordered_by_loss],
        "largest_loss": ordered_by_loss[0]["name"],
        "weakest_rate": ordered_by_rate[-1]["name"],
        "strongest_rate": ordered_by_rate[0]["name"],
    }


def analyze_target(
    records: list[dict[str, object]],
    signature: dict[str, object],
) -> dict[str, object]:
    valid_shenlun = [record for record in records if float(record["申论成绩"]) > 0]
    valid_xingce = [record for record in records if float(record["行测成绩"]) > 0]
    complete = [
        record
        for record in records
        if float(record["总分成绩"]) > 0
        and float(record["申论成绩"]) > 0
        and float(record["行测成绩"]) > 0
    ]
    targets = [
        record
        for record in records
        if float(record["总分成绩"]) == TARGET["total"]
        and float(record["申论成绩"]) == TARGET["shenlun"]
        and float(record["行测成绩"]) == TARGET["xingce"]
    ]
    if len(targets) != 1:
        raise ValueError(f"本人成绩行定位不唯一：{len(targets)}")
    target = targets[0]

    module_rows = []
    for name, maximum, step, questions, _, _ in MODULE_SPECS:
        score = float(target[name])
        values = [float(record[name]) for record in valid_xingce]
        summary = metric_summary(values)
        module_rows.append(
            {
                "name": name,
                "score": score,
                "maximum": maximum,
                "rate": round(score / maximum * 100, 1),
                "correct": round(score / step),
                "questions": questions,
                "class_mean": summary["mean"],
                "class_median": summary["median"],
                "class_p25": summary["p25"],
                "class_p75": summary["p75"],
                "class_rank": competition_rank(values, score),
                "class_n": summary["n"],
                "delta_mean": round(score - float(summary["mean"]), 2),
                "delta_previous": round(score - PREVIOUS[name], 1),
                "lost": round(maximum - score, 1),
            }
        )

    expected_by_name = {module["name"]: float(module["score"]) for module in signature["modules"]}
    for row in module_rows:
        row["review_expected"] = expected_by_name[row["name"]]
        row["review_delta"] = round(row["score"] - expected_by_name[row["name"]], 1)

    total_values = [float(record["总分成绩"]) for record in complete]
    shenlun_values = [float(record["申论成绩"]) for record in valid_shenlun]
    xingce_values = [float(record["行测成绩"]) for record in valid_xingce]
    total = float(target["总分成绩"])
    shenlun = float(target["申论成绩"])
    xingce = float(target["行测成绩"])
    return {
        "target": {
            "total": total,
            "shenlun": shenlun,
            "xingce": xingce,
            "total_grade_rank": int(target["总分排名"]),
            "shenlun_grade_rank": int(target["申论排名"]),
            "xingce_grade_rank": int(target["行测排名"]),
            "total_class_rank": competition_rank(total_values, total),
            "total_class_n": len(total_values),
            "shenlun_class_rank": competition_rank(shenlun_values, shenlun),
            "shenlun_class_n": len(shenlun_values),
            "xingce_class_rank": competition_rank(xingce_values, xingce),
            "xingce_class_n": len(xingce_values),
            "complete_n": len(complete),
            "delta_total": round(total - PREVIOUS["total"], 1),
            "delta_shenlun": round(shenlun - PREVIOUS["shenlun"], 1),
            "delta_xingce": round(xingce - PREVIOUS["xingce"], 1),
        },
        "total": metric_summary(total_values),
        "shenlun": metric_summary(shenlun_values),
        "xingce": metric_summary(xingce_values),
        "modules": module_rows,
        "review_mismatch": [
            {
                "name": row["name"],
                "official_score": row["score"],
                "review_implied_score": row["review_expected"],
                "delta": row["review_delta"],
            }
            for row in module_rows
            if row["review_delta"] != 0
        ],
    }


def write_outputs(rows: list[list[str]], records: list[dict[str, object]], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    with (output_dir / "scores_raw.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(table.HEADERS)
        writer.writerows(rows)
    with (output_dir / "scores_clean.json").open("w", encoding="utf-8") as handle:
        json.dump(records, handle, ensure_ascii=False, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(description="识别 11月13日成绩表并定位本人成绩行")
    parser.add_argument("image", type=Path)
    parser.add_argument("--answers", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    # First three detected bands are the banner, column header and "标准" row.
    rows = table.extract(table.imread(args.image))[3:]
    records = table.repair_records(rows)
    authored = json.loads(args.answers.read_text(encoding="utf-8"))["answers"]
    signature = expected_signature(authored)
    analysis = analyze_target(records, signature)
    analysis["shenlun_items"] = analyze_shenlun()
    write_outputs(rows, records, args.out)
    (args.out / "analysis_summary.json").write_text(
        json.dumps(analysis, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(
        json.dumps(
            {
                "rows": len(rows),
                "review_counts": {
                    "listed": signature["listed"],
                    "wrong": len(signature["wrong"]),
                    "lucky": len(signature["lucky"]),
                    "implied_xingce": signature["xingce"],
                },
                "target": analysis["target"],
                "review_mismatch": analysis["review_mismatch"],
                "output": str(args.out),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
