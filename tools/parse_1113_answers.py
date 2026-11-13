from __future__ import annotations

import json
import os
import re
from pathlib import Path


AI_ROOT = Path(os.environ["AI_ROOT"])
WORK = AI_ROOT / "Codex  Thing" / "素材" / "11月13日模考_识别结果"
RAW = WORK / "src" / "答案.raw.txt"
OUTPUT = WORK / "src" / "answers.json"

PAGE_SPLIT = re.compile(r"===== PAGE (\d+) =====")
ANSWER_START = re.compile(r"(?m)^\s*(\d{1,3})\.【答案】([A-D])")
PAGE_FOOTER = re.compile(
    r"《行政职业能力测验》参考答案与解析\s*第\s*\d+\s*页\s*（共\s*27\s*页）"
)
NOISE = {
    "内部资料 请勿外泄",
    "内部资料请勿外泄",
    "2027 年度公务员录用考试",
    "《行政职业能力测验》提升卷四参考答案及解析",
}

SECTION_RANGES = {
    "政治理论": (1, 20),
    "常识判断": (21, 30),
    "言语理解与表达": (31, 60),
    "数量关系": (61, 75),
    "判断推理": (76, 110),
    "资料分析": (111, 130),
}


def page_for_offset(page_starts: list[tuple[int, int]], offset: int) -> int:
    page = 1
    for page_number, start in page_starts:
        if start > offset:
            break
        page = page_number
    return page


def clean_text(text: str) -> str:
    text = PAGE_SPLIT.sub("\n", text)
    text = PAGE_FOOTER.sub("", text)
    lines: list[str] = []
    for line in text.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if not line or line in NOISE:
            continue
        if re.match(r"^第[一二三四五六]+部分\s+", line):
            continue
        lines.append(line)
    text = " ".join(lines)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])", "", text)
    text = re.sub(r"\s+([，。；：！？、）】])", r"\1", text)
    text = re.sub(r"([（【])\s+", r"\1", text)
    text = re.sub(r"\s*([—\-－])\s*", r"\1", text)
    return text


def main() -> None:
    raw = RAW.read_text(encoding="utf-8")
    page_starts = [
        (int(match.group(1)), match.start())
        for match in PAGE_SPLIT.finditer(raw)
    ]
    matches = list(ANSWER_START.finditer(raw))
    if len(matches) != 130:
        raise ValueError(f"答案起始标记应为 130 条，实际 {len(matches)} 条")

    parsed: dict[str, dict[str, object]] = {}
    next_number = 1
    for index, match in enumerate(matches):
        source_number = int(match.group(1))
        if source_number != next_number:
            raise ValueError(
                f"答案顺序异常：期望 {next_number}，读到 {source_number}"
            )

        end = matches[index + 1].start() if index + 1 < len(matches) else len(raw)
        body = raw[match.end() : end]
        if "解析：" in body:
            body = body.split("解析：", 1)[1]
        explanation = clean_text(body)
        if not explanation:
            raise ValueError(f"第 {source_number} 题解析为空")

        parsed[str(source_number)] = {
            "number": source_number,
            "answer": match.group(2),
            "page": page_for_offset(page_starts, match.start()),
            "explanation": explanation,
        }
        next_number += 1

    sections: dict[str, dict[str, object]] = {}
    for name, (start, end) in SECTION_RANGES.items():
        numbers = list(range(start, end + 1))
        if any(str(number) not in parsed for number in numbers):
            raise ValueError(f"{name} 缺题：{numbers}")
        sections[name] = {
            "start": start,
            "end": end,
            "answers": "".join(parsed[str(number)]["answer"] for number in numbers),
        }

    payload = {
        "period": "提升卷四（11月13日模考）",
        "source": "新【向尚教育】2027年寄宿制行测-提升卷（4）-答案版(1).pdf",
        "sourcePages": 27,
        "questionCount": 130,
        "sections": sections,
        "answers": parsed,
    }
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"answers={len(parsed)} output={OUTPUT}")
    for name, data in sections.items():
        print(f"{name}: {data['start']}-{data['end']} {data['answers']}")


if __name__ == "__main__":
    main()
