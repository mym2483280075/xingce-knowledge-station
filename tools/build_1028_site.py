from __future__ import annotations

import html
import json
import os
import re
import shutil
from collections import Counter
from pathlib import Path

from PIL import Image

from data_1028 import (
    ANSWER_OVERRIDES,
    DISPLAY,
    ISSUE,
    MAT_106,
    MAT_111,
    MAT_116,
    MAT_116_TABLE,
    MAT_121,
    MAT_126,
    MAT_126_TABLE,
    PERIOD,
    Q_OVERRIDES,
    SN_MATERIALS,
    SN_QUESTIONS,
    WRONG_ANSWER_RAW,
)


AI_ROOT = Path(os.environ["AI_ROOT"])
WORK = AI_ROOT / "Codex  Thing" / "素材" / "提升卷二（10月28日）_识别结果"
SN_WORK = AI_ROOT / "Codex  Thing" / "素材" / "提升卷二（10月28日）_申论识别结果"
SITE = AI_ROOT / "Codex  Thing" / "xingce-knowledge-station"
MOCK = SITE / "sections" / "每周模考"
OUTPUT = MOCK / PERIOD
ASSETS = OUTPUT / "行测_assets"
TEMPLATE_XC = MOCK / "10月26日模考" / "行测.html"
TEMPLATE_SN = MOCK / "10月26日模考" / "申论.html"
TEMPLATE_CT = MOCK / "10月26日模考" / "行测错题集合.html"
TEMPLATE_CJ = MOCK / "10月26日模考" / "成绩分析.html"

MODULES = [
    ("政治理论", "zz", 1, 20, "习思想 · 马克思主义基本原理"),
    ("常识判断", "cs", 21, 35, "文史 · 科技 · 经济 · 地理 · 法律"),
    ("言语理解", "yy", 36, 65, "逻辑填空 · 片段阅读 · 语句表达"),
    ("数量关系", "sl", 66, 75, "数学运算 · 速算"),
    ("判断推理", "pd", 76, 110, "图形 · 定义 · 类比 · 逻辑"),
    ("资料分析", "zl", 111, 130, "统计材料 · 图表 · 速算"),
]

SCORING = [
    ("政治理论", 1, 20, 0.8),
    ("常识判断", 21, 35, 0.6),
    ("言语理解", 36, 65, 0.7),
    ("数量关系", 66, 75, 0.9),
    ("图形推理", 76, 85, 0.7),
    ("定义判断", 86, 95, 0.8),
    ("类比推理", 96, 100, 0.8),
    ("逻辑判断", 101, 110, 0.8),
    ("资料分析", 111, 130, 0.9),
]

JUDGMENT_PARTS = [
    ("图形推理", 76, 85),
    ("定义判断", 86, 95),
    ("类比推理", 96, 100),
    ("逻辑判断", 101, 110),
]

FIG_IMAGES = {
    str(number): f"判断推理/q{number:03d}.jpg" for number in range(76, 86)
}
FIG_IMAGES["91"] = "判断推理/q091.jpg"
FIG_IMAGES["114"] = "资料分析/q114-charts.jpg"


def esc(value: object) -> str:
    return html.escape(str(value), quote=False)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def extract_head(template: Path, title: str, local_id: str) -> str:
    text = read(template)
    head = re.search(r"<head>(.*?)</head>", text, flags=re.S)
    if not head:
        raise ValueError(f"模板缺少 head：{template}")
    content = head.group(1)
    content = re.sub(
        r"<title>.*?</title>",
        f"<title>{esc(title)}</title>",
        content,
        count=1,
        flags=re.S,
    )
    content = content.replace('id="mock17-local"', f'id="{local_id}"')
    content = content.replace('id="mock26-local"', f'id="{local_id}"')
    return f"<head>{content}</head>"


def final_script(template: Path) -> str:
    text = read(template)
    matches = re.findall(
        r'<script src="../../../assets/[^"]+\?v=[^"]+"></script>', text
    )
    if not matches:
        raise ValueError(f"模板未找到共享页脚脚本：{template}")
    return matches[-1]


def convert_assets() -> dict[str, dict[str, object]]:
    source = WORK / "assets_raw"
    images = {}
    used = set(FIG_IMAGES.values()) | {
        "资料分析/mat116-chart.jpg",
        "资料分析/mat121-chart-table.jpg",
    }
    if ASSETS.exists():
        shutil.rmtree(ASSETS)
    for jpg in sorted(source.rglob("*.jpg")):
        relative = jpg.relative_to(source)
        if str(relative).replace("\\", "/") not in used:
            continue
        webp = ASSETS / relative.with_suffix(".webp")
        webp.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(jpg) as image:
            image.save(webp, "WEBP", quality=90, method=6)
            width, height = image.size
        images[str(relative).replace("\\", "/")] = {
            "rel": str(relative.with_suffix(".webp")).replace("\\", "/"),
            "width": width,
            "height": height,
        }
    return images


def img_html(
    images: dict[str, dict[str, object]],
    source_rel: str,
    alt: str,
    caption: str | None = None,
) -> str:
    item = images[source_rel]
    prefix = (
        f'<p class="bdtitle">{esc(caption)}</p>' if caption else ""
    )
    return (
        prefix
        + '<div class="fig"><img src="行测_assets/'
        + esc(item["rel"])
        + f'" alt="{esc(alt)}" width="{item["width"]}" height="{item["height"]}" '
        'loading="lazy" decoding="async"></div>'
    )


def options_html(options: list[list[str] | tuple[str, str]]) -> str:
    if not options:
        return ""
    compact = (
        len(options) == 4
        and all(len(text) <= 24 for _, text in options)
        and sum(len(text) for _, text in options) <= 90
    )
    if compact:
        return '<p class="opt">%s</p>' % esc(
            "　".join(f"{letter}.{text}" for letter, text in options)
        )
    return "".join(
        f'<p class="opt">{letter}.{esc(text)}</p>' for letter, text in options
    )


def stem_html(stem: list[str]) -> str:
    text = "".join(stem).replace("B.C", "B、C").replace("A.B", "A、B")
    text = re.sub(r"(?<!^)(?=[①②③④⑤⑥⑦⑧⑨⑩])", "\n", text)
    text = re.sub(r"(?<!^)(?=（\d+）)", "\n", text)
    return "".join(
        f'<p class="stem">{esc(part)}</p>'
        for part in text.splitlines()
        if part.strip()
    )


def answer_html(
    number: int,
    answers: dict[str, dict[str, object]],
    include_details: bool = True,
) -> str:
    key = str(number)
    item = answers[key]
    analysis = ANSWER_OVERRIDES.get(key, str(item["text"]))
    note = ""
    if number == 1:
        note = "原册解析将③④也写作“说法错误”，但答案栏标为 B；结合题目要求选“正确举措”，页面保留原册解析并注明这一处原文矛盾。"
    elif number == 63:
        note = "原答案册本题题号后漏排句点，已按相邻题序恢复。"
    elif number == 97:
        note = "原答案册本题题号误印为“96”，已按题目顺序恢复为第 97 题。"
    body = (
        '<p>'
        + esc(analysis)
        + (
            '</p><p class="source-note">'
            + esc(note)
            + "</p>"
            if note
            else "</p>"
        )
    )
    inner = (
        '<div class="ansline"><span class="ans-tag">答案</span><b>'
        + esc(item["answer"])
        + '</b></div><div class="expline"><span class="exp-tag">解析</span>'
        + '<div class="ansbody">'
        + body
        + "</div></div>"
    )
    if not include_details:
        return inner
    return (
        '<details class="ansbox"><summary><span class="ans-tag">答案</span>'
        "点击查看答案与解析</summary>"
        + inner
        + "</details>"
    )


def question_card(
    number: int,
    q: dict,
    section: str,
    answers: dict[str, dict[str, object]],
    images: dict[str, dict[str, object]],
) -> str:
    key = str(number)
    override = Q_OVERRIDES.get(key, {})
    stem = override.get("stem", q["stem"])
    options = override.get("options", q["options"])
    parts = [
        f'<div class="qcard" id="q{number:03d}">',
        f'<div class="qhead">{esc(section)} · 第 {number} 题</div>',
        stem_html(stem),
    ]
    if key in FIG_IMAGES:
        if number == 114:
            alt = "第 114 题 A～D 四张折线图选项（保留卷面原图）"
        elif number == 91:
            alt = "第 91 题 A～D 四把椅子图片选项（保留卷面原图）"
        else:
            alt = f"第 {number} 题图形推理题干及 A～D 选项（保留卷面原图）"
        parts.append(img_html(images, FIG_IMAGES[key], alt))
    parts.append(options_html(options))
    parts.append(answer_html(number, answers))
    parts.append(
        f'<div class="note">来源：{esc(DISPLAY)} · 行测 · '
        f"{esc(section)} · 第 {number} 题</div></div>"
    )
    return "".join(parts)


def simple_question_section(
    start: int,
    end: int,
    name: str,
    questions: dict,
    answers: dict,
    images: dict,
    subheads: dict[int, str] | None = None,
) -> str:
    parts = []
    subheads = subheads or {}
    for number in range(start, end + 1):
        if number in subheads:
            parts.append(f'<div class="subhead"><b>{esc(subheads[number])}</b></div>')
        parts.append(
            question_card(number, questions[str(number)], name, answers, images)
        )
    return "".join(parts)


def material_card(
    material_id: str,
    title: str,
    range_text: str,
    paragraphs: list[str],
    extra: str = "",
) -> str:
    return (
        f'<div class="matcard" id="{material_id}"><div class="mathead">'
        f"{esc(title)}<span>{esc(range_text)}</span></div>"
        + "".join(f"<p>{esc(paragraph)}</p>" for paragraph in paragraphs)
        + extra
        + "</div>"
    )


def basic_table() -> str:
    rows = "".join(
        f"<tr><td>{esc(school)}</td><td>{esc(city)}</td><td>{esc(major)}</td></tr>"
        for school, city, major in MAT_116_TABLE
    )
    return (
        '<p class="bdtitle">表　2025 年毕业生薪酬排名前十院校的基本情况</p>'
        '<div class="tbwrap"><table><thead><tr><th>大学</th><th>大学所在地</th>'
        f"<th>大学专业类型</th></tr></thead><tbody>{rows}</tbody></table></div>"
    )


def survey_table() -> str:
    headers = [
        "评价",
        "国有工矿",
        "国有垦区（农场）",
        "国有林区（林场）",
        "城中村",
        "城市危房",
        "其他",
    ]
    head = "".join(f"<th>{esc(item)}</th>" for item in headers)
    rows = "".join(
        "<tr>"
        + "".join(f"<td>{esc(value)}</td>" for value in row)
        + "</tr>"
        for row in MAT_126_TABLE
    )
    return (
        '<p class="bdtitle">表　受访棚户区居民对配套公共服务设施改造状况的评价'
        "（单位：%）</p>"
        f'<div class="tbwrap"><table><thead><tr>{head}</tr></thead>'
        f"<tbody>{rows}</tbody></table></div>"
    )


def build_module_html(
    name: str,
    slug: str,
    start: int,
    end: int,
    subtitle: str,
    questions: dict,
    answers: dict,
    images: dict,
) -> str:
    if name == "判断推理":
        subheads = {
            76: "一、图形推理。请按每道题的答题要求作答。",
            86: "二、定义判断。每道题先给出一个概念的定义，从四个选项中选出最符合或最不符合定义的一项。",
            96: "三、类比推理。每道题先给出一组相关的词，从选项中找出逻辑关系最贴近、相似或匹配的一组。",
            101: "四、逻辑判断。每段陈述被假设为正确，要求根据陈述选出可直接推出的答案。",
        }
        body = (
            '<div class="pintro">（共 35 题）图形推理 10 题、定义判断 10 题、'
            "类比推理 5 题、逻辑判断 10 题。</div>"
        )
        body += simple_question_section(
            start, end, name, questions, answers, images, subheads
        )
        body = body.replace(
            '<div class="qcard" id="q106">',
            material_card(
                "mat-106-110",
                "第 106～110 题共用题干",
                "飞机起飞顺序",
                MAT_106,
            )
            + '<div class="qcard" id="q106">',
            1,
        )
    elif name == "资料分析":
        body = (
            '<div class="pintro">（共 20 题）四组材料，每组材料后附 5 道题。</div>'
        )
        body += material_card(
            "mat-111-115",
            "资料一",
            "回答 111～115 题",
            MAT_111,
        )
        body += simple_question_section(
            111, 115, name, questions, answers, images
        )
        body += material_card(
            "mat-116-120",
            "资料二",
            "回答 116～120 题",
            MAT_116,
            img_html(
                images,
                "资料分析/mat116-chart.jpg",
                "2025 年毕业生薪酬排名前十院校的平均薪酬及同比增量柱形图",
                "图　2025 年毕业生薪酬排名前十院校的薪酬情况（保留卷面原图）",
            )
            + basic_table(),
        )
        body += simple_question_section(
            116, 120, name, questions, answers, images
        )
        body += material_card(
            "mat-121-125",
            "资料三",
            "回答 121～125 题",
            MAT_121,
            img_html(
                images,
                "资料分析/mat121-chart-table.jpg",
                "2025 年 2 月四家企业有效申诉量柱形图及环比增长率表",
                "图、表　四家企业每百万件快递业务有效申诉量及环比增长率"
                "（保留卷面原图）",
            ),
        )
        body += simple_question_section(
            121, 125, name, questions, answers, images
        )
        body += material_card(
            "mat-126-130",
            "资料四",
            "回答 126～130 题",
            MAT_126,
            survey_table(),
        )
        body += simple_question_section(
            126, 130, name, questions, answers, images
        )
    else:
        body = simple_question_section(
            start, end, name, questions, answers, images
        )

    return (
        f'<div class="module" id="cat-{slug}"><div class="mod-banner">'
        f'<h2>{esc(name)}</h2><p>{esc(subtitle)}</p>'
        f'<span class="num">{end - start + 1} 题</span></div>'
        f'<div class="mod-body">{body}</div></div>'
    )


def build_exam_page(
    questions: dict,
    answers: dict,
    images: dict,
    script_tag: str,
) -> str:
    head = extract_head(
        TEMPLATE_XC,
        f"{DISPLAY} · 行测 · 公考工作站",
        "mock1028-xc",
    )
    toc = []
    modules = []
    for name, slug, start, end, subtitle in MODULES:
        toc.append(
            f'<a class="t-cat" href="#cat-{slug}"><span class="dot"></span>'
            f"<b>{esc(name)}</b><i>{end - start + 1} 题</i></a>"
        )

    for name, slug, start, end, subtitle in MODULES:
        modules.append(
            build_module_html(
                name,
                slug,
                start,
                end,
                subtitle,
                questions,
                answers,
                images,
            )
        )

    intro = (
        "2026 年 10 月 28 日提升卷二行测整卷，共 31 页、130 题：政治理论 20 题、"
        "常识判断 15 题、言语理解与表达 30 题、数量关系 10 题、判断推理 35 题、"
        "资料分析 20 题。题干、选项和共用材料已逐页文字化；图形推理 76～85 题、"
        "定义判断第 91 题、资料分析第 114 题的图形选项与三组统计图表保留卷面原图。"
        "官方答案版 24 页的 130 题答案与解析已逐题录入，数量关系与资料分析的分数、"
        "百分数和比较过程已按页图整理为一行式；第 63 题题号漏排句点、第 97 题误印为"
        "“96”，均已在答案区内注明。"
    )
    subnav = """
<div class="subnav">
  <a href="../../每周模考.html">← 模考中心</a>
  <a class="on" href="行测.html">行测</a>
  <a href="申论.html">申论</a>
  <a href="行测错题集合.html">行测错题集合</a>
  <a href="成绩分析.html">成绩分析</a>
</div>"""
    toolbar = """
<div class="toolbar">
  <input id="q" placeholder="搜索本页题目关键词，回车定位…">
  <span class="hitcount" id="hitcount"></span>
  <span class="chip done">答案与解析已录入</span>
</div>"""
    body = "\n".join(
        [
            '<!DOCTYPE html>',
            '<html lang="zh-CN" data-theme="mock">',
            head,
            "<body>",
            "<header>",
            f"  <h1>{esc(DISPLAY)} · 行测</h1>",
            f'  <div class="intro">{esc(intro)}</div>',
            '  <div class="meta"><span>31 页 / 130 题</span>'
            "<span>官方答案解析 24 页</span><span>图形与图表保留原图</span>"
            "<span>错题清单已拆分</span></div>",
            "</header>",
            subnav,
            toolbar,
            '<div class="layout">',
            f'  <nav class="toc" id="toc">{"".join(toc)}</nav>',
            '  <main id="main">',
            '<div class="bannote">提示：题干与选项以卷面为准；原答案册第 97 题题号'
            "重复印作“96”，页面根据第 96～98 题的连续解析内容恢复题号。"
            "错题集合中的“我的答案”仅用于本次复盘，不代表官方答案。</div>",
            "".join(modules),
            "  </main>",
            "</div>",
            '<button class="backtop" id="backtop" title="回到顶部">↑</button>',
            script_tag,
            "</body>",
            "</html>",
        ]
    )
    return body


def sn_answer_sections() -> dict[str, str]:
    raw = read(SN_WORK / "src" / "申论答案.raw.txt")
    five = raw.split("赋分一", 1)[1]
    five = five.split("赋分二", 1)[0]
    starts = list(re.finditer(r"(?m)^第([一二三四五])题：", five))
    if len(starts) != 5:
        raise ValueError(f"申论答案应识别 5 题，实际 {len(starts)} 题")
    sections = {}
    for index, start in enumerate(starts):
        end = starts[index + 1].start() if index + 1 < len(starts) else len(five)
        sections[f"sq{index + 1}"] = five[start.start() : end]
    return sections


def format_sn_answer(raw: str) -> str:
    raw = re.sub(r"===== PAGE \d+ =====", "", raw)
    lines = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        if line in {"《申论》题本 第 1 页 （共 10 页）", "内部资料 切勿外泄"}:
            continue
        if line.startswith("《申论》题本"):
            continue
        lines.append(line)

    blocks: list[str] = []
    current: list[str] = []
    heading = re.compile(
        r"^(【参考答案[一二]?】|【思路[一二]】|【范文[一二]】|[一二三四五]、|C[1-7]：)"
    )
    numbered = re.compile(r"^\d+[.．]")
    for line in lines:
        if (heading.match(line) or numbered.match(line)) and current:
            blocks.append("".join(current))
            current = []
        current.append(line)
    if current:
        blocks.append("".join(current))

    rendered = []
    for block in blocks:
        block = re.sub(
            r"(【[^】]*分】)",
            r'<b class="pt">\1</b>',
            esc(block),
        )
        if re.match(r"^(【参考答案|【思路|【范文|[一二三四五]、|C[1-7]：)", block):
            rendered.append(f'<p class="sh">{block}</p>')
        else:
            rendered.append(f"<p>{block}</p>")
    return "".join(rendered)


def build_shenlun_page(script_tag: str) -> str:
    head = extract_head(
        TEMPLATE_SN,
        f"{DISPLAY} · 申论 · 公考工作站",
        "mock1028-sn",
    )
    answers = sn_answer_sections()
    cards = []
    for material_index, material in enumerate(SN_MATERIALS, 1):
        title, messages = material
        cards.append(
            material_card(f"mat-{material_index}", title, "给定资料", messages)
        )

    questions = []
    notes = {
        "sq1": "原册第一题分项采分点显性列出合计 9 分，另有“其他如有，可酌情 1 分”，"
        "合计 10 分，页面按原册结构照录。",
        "sq2": "原册“生产方式方式的转化”按原卷照录。",
        "sq5": "第五题给出两种写作思路、两篇参考范文；答案区保留结构与全文，供自写后对照。",
    }
    for item in SN_QUESTIONS:
        qid = item["id"]
        answer = format_sn_answer(answers[qid])
        questions.append(
            f'<div class="shen" id="{qid}"><div class="qh">申论 · 第 '
            f'{qid[2:]} 题</div><p class="stem">{esc(item["stem"])}</p>'
            f'<p class="opt">{esc(item["request"])}</p>'
            '<details class="ansbox"><summary><span class="mtag ans">参考答案</span>'
            f"点击查看参考答案与评分标准</summary><div class=\"ref\">"
            f'<div class="refbd">{answer}</div></div></details>'
            + (
                f'<div class="source-note">{esc(notes[qid])}</div>'
                if qid in notes
                else ""
            )
            + f'<div class="note">来源：{esc(DISPLAY)} · 申论 · 第 {qid[2:]} 题</div>'
            "</div>"
        )

    intro = (
        "提升卷二申论题本共 10 页，给定资料 7 则，作答要求 5 题。题本已逐页文字化，"
        "卷面手写批注、划线和圈画未录入正文；官方 7 页参考答案已并入每题折叠区，"
        "采用卷面五题版本，前四题保留评分标准与参考答案，第五题保留两种思路和两篇范文。"
    )
    body = "\n".join(
        [
            "<!DOCTYPE html>",
            '<html lang="zh-CN" data-theme="mock">',
            head,
            "<body>",
            "<header>",
            f"  <h1>{esc(DISPLAY)} · 申论</h1>",
            f'  <div class="intro">{esc(intro)}</div>',
            '  <div class="meta"><span>题本 10 页</span><span>材料 7 则</span>'
            "<span>作答 5 题</span><span>官方参考答案 7 页</span>"
            "<span>第五题附两篇范文</span></div>",
            "</header>",
            '<div class="subnav">',
            '  <a href="../../每周模考.html">← 模考中心</a>',
            '  <a href="行测.html">行测</a>',
            '  <a class="on" href="申论.html">申论</a>',
            '  <a href="行测错题集合.html">行测错题集合</a>',
            '  <a href="成绩分析.html">成绩分析</a>',
            "</div>",
            '<div class="toolbar">',
            '  <input id="q" placeholder="搜索材料、题目或评分标准关键词…">',
            '  <span class="hitcount" id="hitcount"></span>',
            '  <button class="btn" id="hideans">展开全部答案</button>',
            "</div>",
            '<div class="wrap">',
            '<div class="module" id="cailiao"><div class="mod-banner">'
            "<h2>给定资料</h2><p>材料 1～材料 7（已文字化）</p>"
            '<span class="num">7 则</span></div><div class="mod-body">',
            '<div class="bannote">提示：答案册同时提供“5 题版本”和“4 题版本”。'
            "本题本为 5 题版本，页面只采用前者；第四题、第五题的答案区均按原册保留完整结构。"
            "</div>",
            "".join(cards),
            "</div></div>",
            '<div class="module" id="zuoda"><div class="mod-banner">'
            '<h2>作答要求</h2><p>单一题 · 综合分析 · 对策 · 公文 · 大作文</p>'
            '<span class="num">5 题</span></div><div class="mod-body">',
            "".join(questions),
            "</div></div>",
            "</div>",
            '<button class="backtop" id="backtop" title="回到顶部">↑</button>',
            script_tag,
            "</body>",
            "</html>",
        ]
    )
    return body


def parse_user_answers(raw: str) -> dict[int, str]:
    normalized = re.sub(r"\s+", "", raw)
    result = {}
    for part in normalized.split(","):
        if not part:
            continue
        match = re.fullmatch(r"(\d+)([A-Da-d])", part)
        if match:
            result[int(match.group(1))] = match.group(2).upper()
            continue
        match = re.fullmatch(r"(\d+)到(\d+)均([A-Da-d])", part)
        if match:
            for number in range(int(match.group(1)), int(match.group(2)) + 1):
                result[number] = match.group(3).upper()
            continue
        raise ValueError(f"无法识别作答片段：{part}")
    return dict(sorted(result.items()))


def module_for(number: int) -> tuple[str, str]:
    for name, slug, start, end, _ in MODULES:
        if start <= number <= end:
            return name, slug
    raise ValueError(number)


def review_card(
    number: int,
    user_answer: str,
    official_answer: str,
    questions: dict,
    answers: dict,
    images: dict,
) -> str:
    q = questions[str(number)]
    module, slug = module_for(number)
    override = Q_OVERRIDES.get(str(number), {})
    stem = override.get("stem", q["stem"])
    options = override.get("options", q["options"])
    analysis = ANSWER_OVERRIDES.get(str(number), str(answers[str(number)]["text"]))
    lucky = user_answer == official_answer
    parts = [
        f'<div class="qcard" id="cat-{slug}-q{number:03d}">',
        f'<div class="qhead">{esc(module)} · 第 {number} 题</div>',
        stem_html(stem),
    ]
    if str(number) in FIG_IMAGES:
        parts.append(
            img_html(
                images,
                FIG_IMAGES[str(number)],
                f"第 {number} 题图形/图表（保留卷面原图）",
            )
        )
    parts.append(options_html(options))
    parts.append(
        '<div class="mine"><span class="ans-tag">我的答案</span><b>'
        + esc(user_answer)
        + "</b>"
        + ("<span class=\"todo\"> · 不确定但答对</span>" if lucky else "")
        + "</div>"
    )
    parts.append(
        '<div class="ansline"><span class="ans-tag">正确答案</span><b>'
        + esc(official_answer)
        + "</b></div>"
    )
    parts.append(
        '<div class="rtags"><span class="kp-tag">考点：'
        + esc(module)
        + "</span>"
        + (
            '<span class="rtag">蒙对：当时为什么不确定？</span>'
            '<span class="rtag">复盘：待填写</span>'
            if lucky
            else '<span class="rtag">错因：待复盘</span>'
        )
        + "</div>"
    )
    parts.append(
        '<div class="expline"><span class="exp-tag">解析</span><div class="ansbody">'
        f"<p>{esc(analysis)}</p></div></div>"
    )
    parts.append(
        f'<div class="note">来源：{esc(DISPLAY)} · 行测 · '
        f"{esc(module)} · 第 {number} 题</div></div>"
    )
    return "".join(parts)


def build_review_page(
    questions: dict,
    answers: dict,
    images: dict,
    user: dict[int, str],
    script_tag: str,
) -> str:
    official = {number: answers[str(number)]["answer"] for number in range(1, 131)}
    wrong = [number for number, answer in user.items() if official[number] != answer]
    lucky = [number for number, answer in user.items() if official[number] == answer]
    if len(user) != 54 or len(wrong) != 47 or len(lucky) != 7:
        raise ValueError(
            f"错题清单校验失败：全部 {len(user)}、错 {len(wrong)}、蒙对 {len(lucky)}"
        )

    head = extract_head(
        TEMPLATE_CT,
        f"{DISPLAY} · 行测错题集合 · 公考工作站",
        "mock1028-ct",
    )
    marked = set(user)
    toc = []
    modules = []
    for name, slug, start, end, subtitle in MODULES:
        selected = [number for number in user if start <= number <= end]
        if not selected:
            continue
        toc.append(
            f'<a class="t-cat" href="#cat-{slug}"><span class="dot"></span>'
            f"<b>{esc(name)}</b><i>{len(selected)} 题</i></a>"
        )
        module_wrong = sum(number in wrong for number in selected)
        module_lucky = sum(number in lucky for number in selected)
        body = (
            f'<div class="pintro">本模块共 {len(selected)} 道标记题；其中做错 '
            f"{module_wrong} 道，不确定但选对 {module_lucky} 道。</div>"
        )
        if name == "判断推理" and any(101 <= number <= 110 for number in selected):
            body += material_card(
                "mat-106-110",
                "第 106～110 题共用题干",
                "飞机起飞顺序",
                MAT_106,
            )
        if name == "资料分析":
            if any(111 <= number <= 115 for number in selected):
                body += material_card(
                    "mat-111-115", "资料一", "回答 111～115 题", MAT_111
                )
            if any(116 <= number <= 120 for number in selected):
                body += material_card(
                    "mat-116-120",
                    "资料二",
                    "回答 116～120 题",
                    MAT_116,
                    img_html(
                        images,
                        "资料分析/mat116-chart.jpg",
                        "2025 年毕业生薪酬排名前十院校的薪酬情况",
                    )
                    + basic_table(),
                )
            if any(121 <= number <= 125 for number in selected):
                body += material_card(
                    "mat-121-125",
                    "资料三",
                    "回答 121～125 题",
                    MAT_121,
                    img_html(
                        images,
                        "资料分析/mat121-chart-table.jpg",
                        "四家企业每百万件快递业务有效申诉量及环比增长率",
                    ),
                )

        if name == "判断推理":
            for part_name, part_start, part_end in JUDGMENT_PARTS:
                part_numbers = [
                    number
                    for number in selected
                    if part_start <= number <= part_end
                ]
                if not part_numbers:
                    continue
                body += (
                    f'<div class="subhead"><b>{esc(part_name)}</b>'
                    f"<span>{len(part_numbers)} 道标记题</span></div>"
                )
                body += "".join(
                    review_card(
                        number,
                        user[number],
                        official[number],
                        questions,
                        answers,
                        images,
                    )
                    for number in part_numbers
                )
        else:
            body += "".join(
                review_card(
                    number,
                    user[number],
                    official[number],
                    questions,
                    answers,
                    images,
                )
                for number in selected
            )
        modules.append(
            f'<div class="module" id="cat-{slug}"><div class="mod-banner">'
            f'<h2>{esc(name)}<span class="w">复盘</span></h2>'
            f'<p>{esc(subtitle)}</p><span class="num">{len(selected)} 题</span>'
            f'</div><div class="mod-body">{body}</div></div>'
        )

    choices = Counter(user.values())
    wrong_choices = Counter(user[number] for number in wrong)
    wrong_official = Counter(official[number] for number in wrong)
    body = "\n".join(
        [
            "<!DOCTYPE html>",
            '<html lang="zh-CN" data-theme="mock">',
            head,
            "<body>",
            "<header>",
            f"  <h1>{esc(DISPLAY)} · 行测错题集合</h1>",
            '  <div class="intro">本次作答标记共 54 题：47 道做错，7 道'
            "“当时不确定但选对”。按六大板块合并展示，每题保留我的答案、官方正确答案、"
            "考点与官方解析；蒙对题在卡内单独标注。</div>",
            '  <div class="meta"><span>47 道错题</span><span>7 道蒙对</span>'
            "<span>54 道标记题</span><span>官方答案逐题核对</span></div>",
            "</header>",
            '<div class="subnav">',
            '  <a href="../../每周模考.html">← 模考中心</a>',
            '  <a href="行测.html">行测</a>',
            '  <a href="申论.html">申论</a>',
            '  <a class="on" href="行测错题集合.html">行测错题集合</a>',
            '  <a href="成绩分析.html">成绩分析</a>',
            "</div>",
            '<div class="toolbar">',
            '  <input id="q" placeholder="搜索本页错题、考点或解析，回车定位…">',
            '  <span class="hitcount" id="hitcount"></span>',
            '  <button class="btn" id="hideans">隐藏正确与复盘</button>',
            "</div>",
            '<div class="layout">',
            f'  <nav class="toc" id="toc">{"".join(toc)}</nav>',
            '  <main id="main">',
            '<div class="bannote">口径提示：54 条标记答案中，C '
            f"{choices['C']} 条、D {choices['D']} 条、B {choices['B']} 条、"
            f"A {choices['A']} 条；47 道错题中选 C 的有 {wrong_choices['C']} 条，"
            f"官方答案为 B 的 {wrong_official['B']} 条、D 的 {wrong_official['D']} 条。"
            "数量关系 66～75 全选 C，仅第 68、70、75 题命中；这些题在卡内标为“不确定但答对”。"
            "</div>",
            "".join(modules),
            "  </main>",
            "</div>",
            '<button class="backtop" id="backtop" title="回到顶部">↑</button>',
            script_tag,
            "</body>",
            "</html>",
        ]
    )
    return body


def build_analysis_page(
    answers: dict,
    user: dict[int, str],
    script_tag: str,
) -> str:
    official = {number: answers[str(number)]["answer"] for number in range(1, 131)}
    wrong = [number for number, answer in user.items() if official[number] != answer]
    lucky = [number for number, answer in user.items() if official[number] == answer]
    stats = []
    total_score = 0.0
    total_max = 0.0
    for name, start, end, unit in SCORING:
        total = end - start + 1
        module_wrong = sum(start <= number <= end for number in wrong)
        module_lucky = sum(start <= number <= end for number in lucky)
        correct = total - module_wrong
        score = correct * unit
        maximum = total * unit
        total_score += score
        total_max += maximum
        stats.append(
            {
                "name": name,
                "start": start,
                "end": end,
                "total": total,
                "correct": correct,
                "wrong": module_wrong,
                "lucky": module_lucky,
                "score": score,
                "max": maximum,
                "rate": correct / total * 100,
            }
        )

    if round(total_score, 1) != 63.9:
        raise ValueError(f"反推总分异常：{total_score}")

    table_rows = []
    for item in sorted(stats, key=lambda row: -row["rate"]):
        tag_class = "ok" if item["rate"] >= 80 else "mid" if item["rate"] >= 60 else "bad"
        tag_text = "稳定" if tag_class == "ok" else "可提升" if tag_class == "mid" else "优先补"
        table_rows.append(
            "<tr>"
            f'<td class="nm">{esc(item["name"])}</td>'
            f'<td class="num">{item["max"]:.1f}</td>'
            f'<td class="num d">{item["score"]:.1f}</td>'
            f'<td><div class="bar {tag_class}"><i style="width:{item["rate"]:.1f}%"></i></div>'
            f'<span class="rate">{item["rate"]:.1f}%</span></td>'
            f'<td class="num">{item["correct"]} / {item["total"]}</td>'
            f'<td class="num">{item["wrong"]}</td>'
            f'<td class="num">{item["lucky"]}</td>'
            f'<td><span class="tag {tag_class}">{tag_text}</span></td>'
            "</tr>"
        )

    module_lines = []
    for item in stats:
        wrong_list = [
            number for number in wrong if item["start"] <= number <= item["end"]
        ]
        lucky_list = [
            number for number in lucky if item["start"] <= number <= item["end"]
        ]
        module_lines.append(
            '<div class="wrow">'
            f'<div class="wn">{esc(item["name"])}<i>{item["score"]:.1f} / {item["max"]:.1f}</i></div>'
            f'<div class="wd"><b>错题：</b>{"、".join(map(str, wrong_list)) or "无"}'
            f'<br><b>蒙对：</b>{"、".join(map(str, lucky_list)) or "无"}</div></div>'
        )

    head = extract_head(
        TEMPLATE_CJ,
        f"{DISPLAY} · 行测作答复盘 · 公考工作站",
        "mock1028-cj",
    )
    body = "\n".join(
        [
            "<!DOCTYPE html>",
            '<html lang="zh-CN" data-theme="mock">',
            head,
            "<body>",
            "<header>",
            f"  <h1>{esc(DISPLAY)} · 行测作答复盘</h1>",
            '  <div class="intro">本页依据用户提供的 54 条错题 / 蒙对清单与站内官方'
            "130 题答案逐题比对生成。未列出的 76 题按“作答正确且未标记不确定”计算，"
            "因此 63.9 分是清单反推值，不是正式成绩表。</div>",
            '  <div class="meta"><span>反推 63.9 / 100</span>'
            "<span>47 道做错</span><span>7 道蒙对</span>"
            "<span>正确 83 / 130</span></div>",
            "</header>",
            '<div class="subnav">',
            '  <a href="../../每周模考.html">← 模考中心</a>',
            '  <a href="行测.html">行测</a>',
            '  <a href="申论.html">申论</a>',
            '  <a href="行测错题集合.html">行测错题集合</a>',
            '  <a class="on" href="成绩分析.html">成绩分析</a>',
            '  <a href="../../成绩档案.html">成绩档案 →</a>',
            "</div>",
            "<main>",
            '<section class="scard" id="cj-jielun"><h2>一句话结论 '
            "<em>作答清单反推</em></h2><p class=\"lead\">本次清单反推 "
            "<b>63.9 / 100</b>，共做错 <b>47 题</b>，另有 <b>7 题</b>属于"
            "“不确定但选对”。最大缺口仍是数量关系：66～75 全选 C，仅命中 3 题，"
            "该模块仅得 2.7 / 9 分；言语理解、政治理论和资料分析是失分题量最多的三块。"
            "定义判断 9 / 10、类比推理 4 / 5 是当前最稳的得分底盘。</p>"
            '<div class="kpis">'
            '<div class="kpi warn"><div class="k">清单反推分</div>'
            '<div class="v">63.9<small>/ 100</small></div>'
            '<div class="n">未列题默认正确</div></div>'
            '<div class="kpi warn"><div class="k">做错</div><div class="v">47'
            '<small>题</small></div><div class="n">官方答案逐题核对</div></div>'
            '<div class="kpi"><div class="k">蒙对</div><div class="v">7'
            '<small>题</small></div><div class="n">正确率含“蒙对水分”</div></div>'
            '<div class="kpi"><div class="k">正确题数</div><div class="v">83'
            '<small>/ 130</small></div><div class="n">清单口径</div></div></div></section>',
            '<section class="scard" id="cj-zhenduan"><h2>四条诊断 '
            "<em>先抓能稳定回分的部分</em></h2><div class=\"diag\">"
            '<div class="ditem two"><b>① 数量关系仍靠单字母兜底：3 / 10</b>'
            "<p>66～75 全部选 C，只有 68、70、75 命中。下一阶段先固定工程、行程、"
            "利润、和差倍比、基础排列组合五类入口，数量目标先放在稳定的 3～4 题，"
            "其余题至少排除两个明显错误项。</p></div>"
            '<div class="ditem two"><b>② 言语理解是最大题量缺口：19 / 30</b>'
            "<p>11 道错题横跨逻辑填空、片段阅读和语句表达，说明问题不是单一知识点，"
            "而是中心句、语境对应与排除边界的稳定性不足。复盘时先写“被哪个词误导”，"
            "再提炼可复用的判断规则。</p></div>"
            '<div class="ditem"><b>③ 政治与常识合计丢 15 题</b>'
            "<p>政治 12 / 20、常识 8 / 15。政治失分集中在近义表述与时政概念的精确对应；"
            "常识则要按文史、科技、法律分标签，避免只背答案。</p></div>"
            '<div class="ditem good"><b>④ 已有底盘：定义 90%、类比 80%、图形 70%</b>'
            "<p>判断推理的稳定度已经形成。资料分析虽然错 6 题，但仍为 14 / 20；"
            "优先复盘 114、117、118、120、122、125 的计算位置和概念判断，"
            "不必继续大面积堆题。</p></div></div></section>",
            '<section class="scard" id="cj-modules"><h2>九模块明细 '
            "<em>按 130 题配分口径反推</em></h2>"
            '<p class="pintro">单项配分为政治 16、常识 9、言语 21、数量 9、图形 7、'
            "定义 8、类比 4、逻辑 8、资料 18，合计 100 分。没有正式成绩表，"
            "本表只用于定位错题密度。</p>"
            '<div class="tblwrap"><table class="mod"><thead><tr><th>模块</th>'
            "<th>满分</th><th>得分</th><th>得分率</th><th>正确题数</th>"
            "<th>错题</th><th>蒙对</th><th>判断</th></tr></thead><tbody>"
            + "".join(table_rows)
            + "</tbody></table></div>"
            f'<p class="tnote">校验：各模块正确题数相加为 83，错题合计 47，'
            f"蒙对合计 7；九模块得分相加为 {total_score:.1f} / {total_max:.0f}。"
            "由于没有正式答题卡与成绩表，不能判断漏记错题，也不能评价用时与涂卡顺序。</p></section>",
            '<section class="scard" id="cj-shibai"><h2>错题与蒙对清单 '
            "<em>直接回到题目</em></h2>"
            '<p class="pintro">下列题号均可在 <a href="行测错题集合.html">行测错题集合</a>'
            "中按板块查看官方解析。“蒙对”表示你的答案与正确答案一致，但清单标记为不确定。</p>"
            + "".join(module_lines)
            + "</section>",
            '<section class="scard" id="cj-bufen"><h2>补分路径 '
            "<em>先拿最容易回来的分</em></h2><ol class=\"plan\">"
            "<li><b>第一步：数量从 3 题向 4～5 题推进。</b>先稳定会做的三类，"
            "剩下题目按排除结果选择，停止 10 题统一押 C。</li>"
            "<li><b>第二步：言语压缩不确定项。</b>片段阅读只复盘中心句、转折、因果三类；"
            "逻辑填空把错题词语按搭配、程度、感情色彩归档。</li>"
            "<li><b>第三步：资料分析重做六道错题。</b>先定位数据，再列式，最后估算；"
            "把“找错行、看错同比/环比、选项边界”分别标记。</li>"
            "<li><b>第四步：政治和常识做精修复盘。</b>只记“哪一个词导致判断翻转”，"
            "不把整段解析抄成新的背诵材料。</li></ol>"
            '<div class="goal"><b>下一场最现实的目标：</b>数量多拿 1～2 题，'
            "言语少错 3 题，资料少错 2 题，清单口径即可从 63.9 提升到 68～70 分区间。"
            "</div></section>",
            '<section class="scard" id="cj-shuoming"><h2>数据口径与质量 '
            "<em>看结论前请先读</em></h2><ul class=\"note\">"
            "<li><b>答案来源：</b>官方行测答案版 24 页，130 题逐题核对；"
            "原册第 97 题误印为 96，已按解析顺序恢复。</li>"
            "<li><b>作答来源：</b>用户提供的 54 条标记答案；其中“66到75均C”展开为 10 题。</li>"
            "<li><b>反推假设：</b>未列出的 76 题按答对处理。若还有漏记错题，实际分只会更低。</li>"
            "<li><b>缺失信息：</b>没有正式成绩表、用时、涂卡顺序与逐题作答时间，"
            "因此不生成排名、速度评价或与班级均分的比较。</li>"
            "<li><b>复盘优先级：</b>数量→言语→资料→政治/常识；"
            "判断推理保持回刷，不挤占主要补分时间。</li></ul></section>",
            "</main>",
            '<button class="backtop" id="bt" title="回到顶部">↑</button>',
            script_tag,
            "<script>(function(){var b=document.getElementById('bt');"
            "function f(){if(b)b.classList.toggle('show',window.scrollY>500)}"
            "window.addEventListener('scroll',f,{passive:true});"
            "if(b)b.addEventListener('click',function(){"
            "window.scrollTo({top:0,behavior:'smooth'})});})();</script>",
            "</body>",
            "</html>",
        ]
    )
    return body


def register_period() -> None:
    hub_path = SITE / "sections" / "每周模考.html"
    index_path = SITE / "index.html"
    hub = read(hub_path)
    index = read(index_path)
    if "t:'10月28日模考'" in hub:
        print("期次登记已存在，跳过重复插入")
        return

    description = (
        "2026 年 10 月 28 日提升卷二：行测 31 页、130 题，政治理论 20 题、"
        "常识判断 15 题、言语理解与表达 30 题、数量关系 10 题、判断推理 35 题、"
        "资料分析 20 题；题干、选项与四组资料逐页文字化，图形推理 76～85 题、"
        "定义判断第 91 题和资料分析图表保留卷面原图。官方答案版 24 页已全部录入，"
        "数量关系与资料分析的算式已按页图重排；原册第 97 题题号误印为“96”，已按"
        "题目顺序恢复并注明。用户 54 条标记答案经官方答案核对为 47 道错题、7 道蒙对，"
        "已合并六大板块生成错题集合；数量关系 66～75 全选 C，仅 68、70、75 命中。"
        "申论题本 10 页、给定资料 7 则、作答要求 5 题已文字化；官方 7 页参考答案"
        "采用五题版本，分题折叠收录评分标准、参考答案、写作思路与两篇范文。"
        "本次未提供正式成绩表，成绩分析页只给出清单反推 63.9 / 100，并明确口径。"
    )
    hub_item = (
        "  { t:'10月28日模考', name:'提升卷二（10月28日模考）', no:'第 16 期', "
        "state:'行测 130 题 + 官方答案解析 + 47 道错题 / 7 道蒙对 + "
        "申论 10 页题本与 7 页参考答案 + 清单反推复盘已录入', "
        f"desc:'{description}', "
        "qc:'130 题 · 官方答案解析 24 页 · 已全部录入', "
        "sc:'题本 10 页 · 材料 7 则 · 5 大题 · 官方参考答案 7 页', "
        "cc:'47 道错题 + 7 道蒙对 · 合并六板块', "
        "cj:'清单反推 63.9 / 100 · 正确 83 / 130 · 待正式成绩表' },\n"
    )
    anchor = "  { t:'10月26日模考'"
    count = hub.count(anchor)
    if count != 1:
        raise ValueError(f"模考登记锚点命中 {count} 次")
    hub = hub.replace(anchor, hub_item + anchor, 1)

    index_desc = description
    index_item = (
        "{ id:'mk-261028', name:'提升卷二（10月28日模考）', en:'2026-10-28', "
        "file:'sections/每周模考.html', color:'#f43f5e', "
        "sub:'行测 130 题 + 官方答案解析 · 47 道错题 + 7 道蒙对 · "
        "申论 10 页题本 + 官方参考答案 · 清单反推 63.9', cnt:'第 16 期', "
        f"desc:'{index_desc}', hit:'10月28日模考', "
        "keywords:['10月28日','10月28日模考','提升卷二','提升卷二申论','第十六期',"
        "'第16期','模考','行测','申论','130题','130 题','题本','答案','解析',"
        "'官方答案版','参考答案','评分标准','采分点','参考范文','政治理论','常识判断',"
        "'言语理解','数量关系','判断推理','资料分析','图形推理','绿美生态','绿色工厂',"
        "'永林新村','焦洋翠梨','古树名木','海洋生态环境','错题47道','蒙对7道',"
        "'作答反推63.9','数量关系66-75','全选C','作答复盘'] },\n"
    )
    anchor = "{ id:'mk-261026'"
    count = index.count(anchor)
    if count != 1:
        raise ValueError(f"首页期次锚点命中 {count} 次")
    index = index.replace(anchor, index_item + anchor, 1)
    index = index.replace("cnt:'15 期'", "cnt:'16 期'", 1)
    if "cnt:'16 期'" not in index:
        raise ValueError("总览期数未更新")

    write(hub_path, hub)
    write(index_path, index)


def update_search_fixtures() -> None:
    path = SITE / "scripts" / "search-fixtures.json"
    payload = json.loads(read(path))
    additions = [
        {
            "q": "提升卷二",
            "expect": {"min": 1, "section": "mk-261028"},
            "why": "第 16 期行测 / 申论期次展示名",
        },
        {
            "q": "绿美生态建设",
            "expect": {"min": 1, "section": "mk-261028"},
            "why": "第 16 期申论材料与第五题题干",
        },
        {
            "q": "范家塘村",
            "expect": {"min": 1, "section": "mk-261028"},
            "why": "第 16 期申论材料三正文专名",
        },
        {
            "q": "焦洋翠梨",
            "expect": {"min": 1, "section": "mk-261028"},
            "why": "第 16 期申论材料三与参考答案专名",
        },
    ]
    if not isinstance(payload, dict) or not isinstance(payload.get("queries"), list):
        raise ValueError("search-fixtures.json 结构异常")
    existing = {item.get("q") for item in payload["queries"] if isinstance(item, dict)}
    for item in additions:
        if item["q"] not in existing:
            payload["queries"].append(item)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    questions = json.loads(read(WORK / "src" / "questions.raw.json"))
    answers_payload = json.loads(read(WORK / "src" / "answers.json"))
    answers = answers_payload["answers"]
    if sorted(map(int, questions)) != list(range(1, 131)):
        raise ValueError("题本不是完整 1～130 题")
    if sorted(map(int, answers)) != list(range(1, 131)):
        raise ValueError("答案不是完整 1～130 题")

    images = convert_assets()
    expected_images = set(FIG_IMAGES.values()) | {
        "资料分析/mat116-chart.jpg",
        "资料分析/mat121-chart-table.jpg",
    }
    missing_images = sorted(expected_images - set(images))
    if missing_images:
        raise ValueError(f"缺少裁图资产：{missing_images}")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    script_tag = final_script(TEMPLATE_XC)
    write(
        OUTPUT / "行测.html",
        build_exam_page(questions, answers, images, script_tag),
    )
    write(OUTPUT / "申论.html", build_shenlun_page(script_tag))
    user = parse_user_answers(WRONG_ANSWER_RAW)
    write(
        OUTPUT / "行测错题集合.html",
        build_review_page(questions, answers, images, user, script_tag),
    )
    write(
        OUTPUT / "成绩分析.html",
        build_analysis_page(answers, user, script_tag),
    )
    register_period()
    update_search_fixtures()
    print(f"built={OUTPUT}")
    print(f"images={len(images)}")
    print("registered=第 16 期")


if __name__ == "__main__":
    main()
