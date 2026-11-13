from __future__ import annotations

import json
import os
import re
from pathlib import Path


AI_ROOT = Path(os.environ["AI_ROOT"])
WORK = AI_ROOT / "Codex  Thing" / "素材" / "11月13日模考_识别结果"
OCR = WORK / "ocr_sn"
OUTPUT = WORK / "src" / "shenlun_materials.json"

DROP_LINES = {
    "内部资料切勿外泄",
    "向尚教育",
    "Upward Education",
    "Upwerd Education",
    "Lipward Education",
    "给定资料：",
    "→但建",
    "3、",
    "4. 数字遗营",
    "A",
    "智能",
    "柔性抄法",
    "部门",
    "矫正对队伍薄弱.",
    "志原工作面内富不明确",
}

CORRECTIONS = {
    "醒目—这是": "醒目——这是",
    "自己也成了守护食品安全的啄木鸟’！”": "自己也成了守护食品安全的啄木鸟！”",
    "自己也成了优等生’！”": "自己也成了优等生！”",
    "这一理念被引人": "这一理念被引入",
    "严重安全隐类似问题也": "严重安全隐患，类似问题也",
    "讲解文物保护法厘清职责": "讲解《文物保护法》，厘清职责",
    "被窨并粗暴截断": "被窨井粗暴截断",
    "被宣告死刑": "被宣告缓刑",
    "给家里抹墨": "给家里抹黑",
    "龙桥村村于部": "龙桥村村干部",
    "处理这样的纠纷，\n动心动情比用劲\n用力’更有效果，（打开心结比案件执结’更加重要。":
        "处理这样的纠纷，‘动心动情比用劲用力’更有效果，‘打开心结比案件执结’更加重要。",
    "实现真正的长治久安。\n《申论》": "实现真正的长治久安。”\n《申论》",
}

POST_CORRECTIONS = {
    "龙桥村村于部": "龙桥村村干部",
    "处理这样的纠纷，动心动情比用劲用力’更有效果，（打开心结比案件执结’更加重要。":
        "处理这样的纠纷，‘动心动情比用劲用力’更有效果，‘打开心结比案件执结’更加重要。",
}


def clean_page(path: Path) -> str:
    lines = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = re.sub(r"<!--.*?-->", "", line).strip()
        if not line or line.startswith("# p"):
            continue
        if re.match(r"^《申论》题本", line):
            continue
        if line in DROP_LINES:
            continue
        if re.fullmatch(r"[1-9][.、]?", line):
            continue
        lines.append(line)
    text = "\n".join(lines)
    for source, target in CORRECTIONS.items():
        text = text.replace(source, target)
    return text


def join_paragraph(lines: list[str]) -> str:
    text = ""
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if text and (
            (re.search(r"[A-Za-z0-9]$", text) and re.match(r"[A-Za-z0-9]", line))
            or text.endswith("》")
        ):
            text += " " + line
        else:
            text += line
    text = re.sub(r"\s+", " ", text).strip()
    text = text.replace("(共", "（共")
    text = re.sub(r"\s+([，。；：！？、）】”])", r"\1", text)
    return text


def split_numbered(text: str) -> list[str]:
    text = re.sub(
        r"(?<=[。！？；，…”\n])(?=(?:[1-9])[.．](?=\S))",
        "\n",
        text,
    )
    return [join_paragraph([line]) for line in text.splitlines() if line.strip()]


def main() -> None:
    pages = [clean_page(OCR / f"p{number:02d}.ocr.md") for number in range(1, 10)]
    combined = "\n".join(pages)
    combined = combined.replace("材料2:", "材料2：").replace("材料3：", "材料3：")
    combined = combined.replace("材料4:", "材料4：").replace("材料5：", "材料5：")
    starts = list(re.finditer(r"材料([1-5])[：:]", combined))
    if len(starts) != 5:
        raise ValueError(f"申论材料标记应为 5 个，实际 {len(starts)} 个")

    materials: dict[str, list[str]] = {}
    for index, start in enumerate(starts):
        number = start.group(1)
        end = starts[index + 1].start() if index + 1 < len(starts) else len(combined)
        raw = combined[start.end() : end]
        raw = re.sub(r"\s+", "", raw)
        for source, target in POST_CORRECTIONS.items():
            raw = raw.replace(source, target)
        if number == "2":
            parts = []
            for pattern in [r"(?=我国在)", r"(?=随着人工智能)", r"(?=总结来看)"]:
                raw = re.sub(pattern, "\n", raw)
            parts = [join_paragraph([line]) for line in raw.splitlines() if line]
        else:
            parts = split_numbered(raw)
        materials[number] = parts

    expected = {
        "1": ["市监蓝", "沙盒监管", "精准帮扶", "义务监督员", "三维立体画像"],
        "2": ["多方共赢", "金融科技", "人工智能", "平衡点"],
        "3": ["益·峨眉", "黑颈鹤", "盲道", "普法"],
        "4": ["社区矫正", "专业知识", "社会组织", "就业", "志愿者"],
        "5": ["蓝风铃", "赵法官", "野生猕猴", "法理和常情常理"],
    }
    for number, terms in expected.items():
        body = "".join(materials[number])
        missing = [term for term in terms if term not in body]
        if missing:
            raise ValueError(f"材料{number}关键词缺失：{missing}")

    payload = {
        "period": "提升卷四（11月13日模考）",
        "sourcePages": 10,
        "materials": materials,
    }
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"materials={len(materials)} output={OUTPUT}")
    for number, paragraphs in materials.items():
        print(number, len(paragraphs), sum(map(len, paragraphs)))
        for paragraph in paragraphs:
            print(" ", paragraph[:120])


if __name__ == "__main__":
    main()
