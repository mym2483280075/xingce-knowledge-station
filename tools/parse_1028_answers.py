from __future__ import annotations

import json
import os
import re
from pathlib import Path


AI_ROOT = Path(os.environ["AI_ROOT"])
WORK = AI_ROOT / "Codex  Thing" / "素材" / "提升卷二（10月28日）_识别结果"
RAW = WORK / "src" / "行测答案.raw.txt"
OUTPUT = WORK / "src" / "answers.json"

PAGE_SPLIT = re.compile(r"===== PAGE (\d+) =====")
ANSWER_START = re.compile(r"(\d{1,3})(?:\.)?\s*【答案】\s*([A-D])")
HEADER = re.compile(
    r"《行政职业能力测验》参考答案与解析\s*第\s*\d+\s*页\s*（共\s*24\s*页）",
)
NOISE_LINES = {
    "内部资料 请勿外泄",
    "内部资料请勿外泄",
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
    text = HEADER.sub("", text)
    lines = []
    for line in text.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if not line or line in NOISE_LINES:
            continue
        lines.append(line)
    text = " ".join(lines)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])", "", text)
    text = re.sub(r"\s+([，。；：！？、）】])", r"\1", text)
    text = re.sub(r"([（【])\s+", r"\1", text)
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

    parsed: dict[int, dict[str, object]] = {}
    next_number = 1
    for index, match in enumerate(matches):
        source_number = int(match.group(1))
        number = source_number
        if source_number < next_number:
            number = next_number
        if number != next_number:
            raise ValueError(
                f"答案顺序异常：期望 {next_number}，读到 {source_number}"
            )

        end = matches[index + 1].start() if index + 1 < len(matches) else len(raw)
        body = raw[match.end() : end]
        if "解析：" in body:
            body = body.split("解析：", 1)[1]
        body = clean_text(body)
        parsed[number] = {
            "number": number,
            "answer": match.group(2),
            "page": page_for_offset(page_starts, match.start()),
            "sourceNumber": source_number,
            "text": body,
        }
        next_number += 1

    missing = [number for number in range(1, 131) if number not in parsed]
    if missing:
        raise ValueError(f"答案缺号：{missing}")

    manual = {
        # 原答案册把第 97 题的题号也印成了“96.”；依据相邻题号与解析内容顺序恢复。
        97: "sourceNumber=96（原册题号重复，按上下文恢复为第 97 题）",
        # 原册第 63 题题号后漏排句点，按题序恢复。
        63: "sourceNumber=63（原册题号后漏排句点）",
    }
    if parsed[96]["answer"] != "A" or parsed[97]["answer"] != "D":
        raise ValueError("第 96/97 题答案与页图核对结果不一致")

    payload = {
        "period": "提升卷二（10月28日）",
        "source": "行测答案版.pdf",
        "sourcePages": 24,
        "manualNotes": manual,
        "answers": parsed,
    }
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"answers={len(parsed)} output={OUTPUT}")
    print("key=" + "".join(parsed[number]["answer"] for number in range(1, 131)))


if __name__ == "__main__":
    main()
