from __future__ import annotations

import json
import os
import re
from pathlib import Path


AI_ROOT = Path(os.environ["AI_ROOT"])
WORK = AI_ROOT / "Codex  Thing" / "素材" / "11月13日模考_识别结果"
RAW = WORK / "src" / "申论答案.raw.txt"
OUTPUT = WORK / "src" / "shenlun_answers.json"

QUESTION_START = re.compile(
    r"(?m)^\s*([1-5])[.．]\s*(?=请根据|给定材料|假如|“给定资料)"
)
ANSWER_START = re.compile(r"【参考答案(?:[一二三1-3])?】")
NOISE_LINE = re.compile(
    r"^(?:={5} PAGE \d+ ={5}|《申论》题本|第\d+\s*页（共\d+\s*页）|"
    r"内部资料切勿外泄|强化卷三参考答案)$"
)


def join_lines(lines: list[str]) -> str:
    text = ""
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if not text:
            text = line
            continue
        if re.search(r"[A-Za-z0-9]$", text) and re.match(r"[A-Za-z0-9]", line):
            text += " " + line
        else:
            text += line
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+（计空格", "（计空格", text)
    text = re.sub(
        r"《申论》题本\s*第\s*\d+\s*页\s*（共\s*\d+\s*页）",
        "",
        text,
    )
    return text


def clean_lines(raw: str) -> list[str]:
    lines: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or NOISE_LINE.match(stripped):
            continue
        lines.append(stripped)
    return lines


def split_at_requirement_end(text: str) -> tuple[str, str]:
    match = re.search(r"(?:不超过\d+字。|限1000-1200字。)", text)
    if not match:
        raise ValueError(f"无法定位第五题要求结尾：{text[:80]}")
    return text[: match.end()], text[match.end() :]


def main() -> None:
    raw = RAW.read_text(encoding="utf-8")
    starts = list(QUESTION_START.finditer(raw))
    if len(starts) != 5:
        raise ValueError(f"申论题号应为 5 个，实际 {len(starts)} 个")

    questions: dict[str, dict[str, object]] = {}
    for index, start in enumerate(starts):
        number = int(start.group(1))
        end = starts[index + 1].start() if index + 1 < len(starts) else len(raw)
        block = raw[start.end() : end]
        cleaned = clean_lines(block)

        if number < 5:
            answer_markers = list(ANSWER_START.finditer("\n".join(cleaned)))
            if not answer_markers:
                raise ValueError(f"第 {number} 题缺少参考答案标记")
            first = answer_markers[0]
            demand = join_lines(cleaned[:0])
            # Keep the source order by locating the marker against a joined copy.
            marker_count = sum(
                1 for line in cleaned if ANSWER_START.search(line)
            )
            demand_lines: list[str] = []
            answers: list[dict[str, str]] = []
            current: list[str] | None = None
            label = ""
            for line in cleaned:
                marker = ANSWER_START.search(line)
                if marker:
                    if current:
                        answers.append(
                            {"label": label, "text": join_lines(current)}
                        )
                    current = []
                    label = marker.group(0).strip("【】")
                    remainder = line[marker.end() :].strip()
                    if remainder:
                        current.append(remainder)
                elif current is None:
                    demand_lines.append(line)
                else:
                    current.append(line)
            if current:
                answers.append({"label": label, "text": join_lines(current)})
            if marker_count != len(answers):
                raise ValueError(
                    f"第 {number} 题答案段数异常：{marker_count} / {len(answers)}"
                )
            demand_text = join_lines(demand_lines)
        else:
            demand_lines = []
            answer_lines = []
            in_answer = False
            for line in cleaned:
                if in_answer:
                    answer_lines.append(line)
                    continue
                demand_lines.append(line)
                if "限1000-1200字。" in line:
                    in_answer = True
            demand_text = join_lines(demand_lines)
            if not answer_lines:
                raise ValueError("第五题未找到范文正文")
            answers = [
                {"label": "参考范文", "text": join_lines(answer_lines)}
            ]

        if not demand_text or not answers:
            raise ValueError(f"第 {number} 题解析不完整")
        questions[str(number)] = {
            "number": number,
            "demand": demand_text,
            "answers": answers,
        }

    payload = {
        "period": "提升卷四（11月13日模考）",
        "source": "强化卷三（四川卷）参考答案",
        "sourcePages": 4,
        "questions": questions,
    }
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"shenlun_questions={len(questions)} output={OUTPUT}")
    for number, question in questions.items():
        labels = [answer["label"] for answer in question["answers"]]
        print(number, len(question["demand"]), labels)


if __name__ == "__main__":
    main()
