from __future__ import annotations

import html
import json
import os
import re
from pathlib import Path

from PIL import Image

from data_1113 import (
    ANSWER_OVERRIDES,
    DISPLAY,
    FIG_IMAGES,
    ISSUE,
    MAT_106,
    MAT_111,
    MAT_116,
    MAT_121,
    MAT_126,
    PERIOD,
    Q_OVERRIDES,
    USER_RESPONSE_RAW,
)


AI_ROOT = Path(os.environ["AI_ROOT"])
WORK = AI_ROOT / "Codex  Thing" / "素材" / "11月13日模考_识别结果"
SITE = AI_ROOT / "Codex  Thing" / "xingce-knowledge-station"
MOCK = SITE / "sections" / "每周模考"
OUTPUT = MOCK / PERIOD
ASSETS_RAW = WORK / "assets_raw"
ASSETS = OUTPUT / "行测_assets"
TEMPLATE_XC = MOCK / "10月31日模考" / "行测.html"
TEMPLATE_SN = MOCK / "10月31日模考" / "申论.html"

MODULES = [
    ("政治理论", "zz", 1, 20, "时政 · 理论 · 党建"),
    ("常识判断", "cs", 21, 35, "法律 · 科技 · 人文 · 地理"),
    ("言语理解与表达", "yy", 36, 65, "逻辑填空 · 片段阅读 · 语句表达"),
    ("数量关系", "sl", 66, 75, "比例 · 行程 · 计数 · 几何"),
    ("判断推理", "pd", 76, 110, "图形 · 定义 · 类比 · 逻辑"),
    ("资料分析", "zl", 111, 130, "统计材料 · 图表 · 速算"),
]

MATERIAL_IMAGES = {
    "资料分析/mat116-chart.jpg": "2015-2021年一季度中国电子商务交易总额及同比增速柱形折线图",
    "资料分析/mat121-table.jpg": "2021年H市全国12315平台接收投诉问题的受理量情况表",
    "资料分析/mat126-chart.jpg": "2016-2022年3月我国苜蓿干草进口情况柱形折线图",
}


def esc(value: object) -> str:
    return html.escape(str(value), quote=False)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def extract_head(template: Path, title: str, local_id: str) -> str:
    text = read(template)
    match = re.search(r"<head>(.*?)</head>", text, flags=re.S)
    if not match:
        raise ValueError(f"模板缺少 head：{template}")
    content = match.group(1)
    content = re.sub(
        r"<title>.*?</title>",
        f"<title>{esc(title)}</title>",
        content,
        count=1,
        flags=re.S,
    )
    content = re.sub(
        r'(<style id=")mock[^"]+(">)',
        rf"\g<1>{local_id}\2",
        content,
        count=1,
    )
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
    images: dict[str, dict[str, object]] = {}
    used = set(FIG_IMAGES.values()) | set(MATERIAL_IMAGES)
    for relative in sorted(used):
        source = ASSETS_RAW / Path(relative)
        if not source.is_file():
            raise FileNotFoundError(source)
        target = ASSETS / Path(relative).with_suffix(".webp")
        target.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as image:
            rgb = image.convert("RGB")
            rgb.save(target, "WEBP", quality=90, method=6)
            width, height = rgb.size
        images[relative] = {
            "rel": Path(relative).with_suffix(".webp").as_posix(),
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
    prefix = f'<p class="bdtitle">{esc(caption)}</p>' if caption else ""
    return (
        prefix
        + '<div class="fig"><img src="行测_assets/'
        + esc(item["rel"])
        + f'" alt="{esc(alt)}" width="{item["width"]}" height="{item["height"]}" '
        'loading="lazy" decoding="async"></div>'
    )


def clean_copy(text: str) -> str:
    replacements = {
        "营养和水分输断": "营养和水分输导中断",
        "经鉴古家宋荦仲鉴识": "经鉴古家宋荦重新鉴识",
        "若于关键事件": "若干关键事件",
        "辅动因子": "辅助因子",
        "苜蓿于草": "苜蓿干草",
        "全球发展倡议一—": "全球发展倡议——",
        "全球安全倡议—": "全球安全倡议——",
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    return text


def stem_html(stem: list[str]) -> str:
    text = clean_copy("".join(stem).replace("(）", "（）").replace("(1)", "①"))
    text = re.sub(r"(?<!^)(?=[①②③④⑤⑥⑦⑧⑨⑩])", "\n", text)
    text = re.sub(r"(?<!^)(?=（\d+）)", "\n", text)
    lines = [part.strip() for part in text.splitlines() if part.strip()]
    return "".join(f'<p class="stem">{esc(line)}</p>' for line in lines)


def options_html(options: list[list[str] | tuple[str, str]]) -> str:
    if not options:
        return ""
    options = [(letter, clean_copy(text)) for letter, text in options]
    compact = (
        len(options) == 4
        and all(len(text) <= 20 for _, text in options)
        and sum(len(text) for _, text in options) <= 72
    )
    if compact:
        return '<p class="opt">%s</p>' % esc(
            "　".join(f"{letter}.{text}" for letter, text in options)
        )
    return "".join(
        f'<p class="opt">{letter}.{esc(text)}</p>' for letter, text in options
    )


def answer_html(number: int, answers: dict[str, dict[str, object]]) -> str:
    key = str(number)
    item = answers[key]
    analysis = ANSWER_OVERRIDES.get(key, str(item["explanation"]))
    return (
        '<details class="ansbox"><summary><span class="ans-tag">答案</span>'
        "点击查看答案与解析</summary>"
        '<div class="ansline"><span class="ans-tag">答案</span><b>'
        + esc(item["answer"])
        + '</b></div><div class="expline"><span class="exp-tag">解析</span>'
        '<div class="ansbody"><p>'
        + esc(analysis)
        + "</p></div></div></details>"
    )


def question_card(
    number: int,
    questions: dict,
    section: str,
    answers: dict,
    images: dict,
) -> str:
    key = str(number)
    source = questions[key]
    override = Q_OVERRIDES.get(key, {})
    stem = override.get("stem", source["stem"])
    options = override.get("options", source["options"])
    parts = [
        f'<div class="qcard" id="q{number:03d}">',
        f'<div class="qhead">{esc(section)} · 第 {number} 题</div>',
        stem_html(stem),
    ]
    if key in FIG_IMAGES:
        if number == 74:
            alt = "第74题题干示意图及A至D四个坐标图选项（保留卷面原图）"
        elif number == 111:
            alt = "第111题A至D四张饼图选项（保留卷面原图）"
        elif number in {82, 83}:
            alt = f"第{number}题六个图形（保留卷面原图）"
        elif number == 84:
            alt = "第84题四个正方体展开图选项（保留卷面原图）"
        elif number == 85:
            alt = "第85题立体图形及其四个选项（保留卷面原图）"
        else:
            alt = f"第{number}题图形及A至D选项（保留卷面原图）"
        parts.append(img_html(images, FIG_IMAGES[key], alt))
    parts.append(options_html(options))
    parts.append(answer_html(number, answers))
    parts.append(
        f'<div class="note">来源：{esc(DISPLAY)} · 行测 · '
        f"{esc(section)} · 第 {number} 题</div></div>"
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


def question_range(
    start: int,
    end: int,
    section: str,
    questions: dict,
    answers: dict,
    images: dict,
    subheads: dict[int, str] | None = None,
) -> str:
    subheads = subheads or {}
    parts = []
    for number in range(start, end + 1):
        if number in subheads:
            parts.append(
                f'<div class="subhead"><b>{esc(subheads[number])}</b></div>'
            )
        parts.append(question_card(number, questions, section, answers, images))
    return "".join(parts)


def build_module(
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
            '<div class="pintro">（共35题）图形推理10题、定义判断10题、'
            "类比推理5题、逻辑判断10题。</div>"
        )
        body += question_range(
            start, end, name, questions, answers, images, subheads
        )
        body = body.replace(
            '<div class="qcard" id="q106">',
            material_card(
                "mat-106-110",
                "第106～110题共用题干",
                "办公楼楼层安排",
                MAT_106,
            )
            + '<div class="qcard" id="q106">',
            1,
        )
    elif name == "资料分析":
        body = (
            '<div class="pintro">（共20题）四组材料，每组材料后附5道题。</div>'
        )
        body += material_card("mat-111-115", "资料一", "回答111～115题", MAT_111)
        body += question_range(111, 115, name, questions, answers, images)
        body += material_card(
            "mat-116-120",
            "资料二",
            "回答116～120题",
            MAT_116,
            img_html(
                images,
                "资料分析/mat116-chart.jpg",
                "2015至2021年一季度中国电子商务交易总额及同比增速",
                "图　2015-2021年一季度中国电子商务交易总额及同比增速",
            ),
        )
        body += question_range(116, 120, name, questions, answers, images)
        body += material_card(
            "mat-121-125",
            "资料三",
            "回答121～125题",
            MAT_121,
            img_html(
                images,
                "资料分析/mat121-table.jpg",
                "2021年H市全国12315平台接收投诉问题的受理量情况表",
                "表　2021年H市全国12315平台接收投诉问题的受理量情况",
            ),
        )
        body += question_range(121, 125, name, questions, answers, images)
        body += material_card(
            "mat-126-130",
            "资料四",
            "回答126～130题",
            MAT_126,
            img_html(
                images,
                "资料分析/mat126-chart.jpg",
                "2016年至2022年3月我国苜蓿干草进口量及同比增速",
                "图　2016-2022年3月我国苜蓿干草进口情况",
            ),
        )
        body += question_range(126, 130, name, questions, answers, images)
    else:
        body = question_range(start, end, name, questions, answers, images)
    return (
        f'<div class="module" id="cat-{slug}"><div class="mod-banner">'
        f'<h2>{esc(name)}</h2><p>{esc(subtitle)}</p>'
        f'<span class="num">{end - start + 1} 题</span></div>'
        f'<div class="mod-body">{body}</div></div>'
    )


def build_exam_page(
    questions: dict, answers: dict, images: dict, script_tag: str
) -> str:
    title = f"{DISPLAY} · 行测 · 公考工作站"
    head = extract_head(TEMPLATE_XC, title, "mock1113-xc")
    toc = "".join(
        f'<a class="t-cat" href="#cat-{slug}"><span class="dot"></span>'
        f"<b>{esc(name)}</b><i>{end - start + 1} 题</i></a>"
        for name, slug, start, end, _ in MODULES
    )
    modules = "".join(
        build_module(
            name, slug, start, end, subtitle, questions, answers, images
        )
        for name, slug, start, end, subtitle in MODULES
    )
    intro = (
        "2026年11月13日提升卷四行测整卷，共30页、130题：政治理论20题、常识判断"
        "15题、言语理解与表达30题、数量关系10题、判断推理35题、资料分析20题。"
        "题干与选项已逐页文字化；图形推理76～85题、第74题坐标图选项、第111题饼图"
        "以及资料分析三组统计图表保留卷面原图。官方答案版27页的130题答案与解析已"
        "全部录入，数量关系及资料分析的分式、比例和速算过程已按页图整理为一行式。"
    )
    body = "\n".join(
        [
            "<!DOCTYPE html>",
            '<html lang="zh-CN" data-theme="mock">',
            head,
            "<body>",
            "<header>",
            f"  <h1>{esc(DISPLAY)} · 行测</h1>",
            f'  <div class="intro">{esc(intro)}</div>',
            '  <div class="meta"><span>30页 / 130题</span>'
            "<span>官方答案解析27页</span><span>图形与图表保留原图</span>"
            "<span>错题清单待补</span></div>",
            "</header>",
            '<div class="subnav">',
            '  <a href="../../每周模考.html">← 模考中心</a>',
            '  <a class="on" href="行测.html">行测</a>',
            '  <a href="申论.html">申论</a>',
            '  <a href="行测错题集合.html">行测错题集合</a>',
            '  <a href="成绩分析.html">成绩分析</a>',
            "</div>",
            '<div class="toolbar">',
            '  <input id="q" placeholder="搜索本页题目关键词，回车定位…">',
            '  <span class="hitcount" id="hitcount"></span>',
            '  <button class="btn" id="hideans">展开全部答案</button>',
            "</div>",
            '<div class="layout">',
            f'  <nav class="toc" id="toc">{toc}</nav>',
            '  <main id="main">',
            '<div class="bannote">题号与答案均以本次题本和官方答案版为准；'
            "图形、统计图和统计表不强行文字化，保留卷面原图。"
            "本次未提供作答清单和正式成绩，错题集合与分析页只做明确占位。</div>",
            modules,
            "  </main>",
            "</div>",
            '<button class="backtop" id="backtop" title="回到顶部">↑</button>',
            script_tag,
            "</body>",
            "</html>",
        ]
    )
    return body


def split_sn_answer(number: int, text: str) -> list[tuple[str, str]]:
    if number == 3:
        index = text.find("“益·峨眉”")
        if index > 0:
            text = text[:index] + "\n" + text[index:]
    if number == 5:
        quote = text.find("“")
        if quote > 0:
            text = text[:quote] + "\n" + text[quote:]
    text = re.sub(
        r"(?<=[。；])(?=(?:[1-5]\.[^0-9]|问题：|建议：|以法理为经|以情理为纬|"
        r"经纬相融|治国有常))",
        "\n",
        text,
    )
    blocks = [block.strip() for block in text.splitlines() if block.strip()]
    return [("sh" if index == 0 and number == 3 else "", block) for index, block in enumerate(blocks)]


def build_shenlun_page(script_tag: str) -> str:
    answers_payload = json.loads(
        read(WORK / "src" / "shenlun_answers.json")
    )
    materials_payload = json.loads(
        read(WORK / "src" / "shenlun_materials.json")
    )
    answers = answers_payload["questions"]
    materials = materials_payload["materials"]
    head = extract_head(
        TEMPLATE_SN,
        f"{DISPLAY} · 申论 · 公考工作站",
        "mock1113-sn",
    )

    material_cards = []
    for number in range(1, 6):
        paragraphs = materials[str(number)]
        if number == 3 and paragraphs[0].endswith("2"):
            paragraphs[0] = paragraphs[0][:-1]
        material_cards.append(
            material_card(
                f"mat-{number}",
                f"材料{number}",
                "给定资料",
                paragraphs,
            )
        )

    question_cards = []
    for number in range(1, 6):
        item = answers[str(number)]
        demand = item["demand"]
        answer_parts = []
        for answer_index, answer in enumerate(item["answers"]):
            label = answer["label"]
            answer_parts.append(
                f'<span class="mtag ans">{esc(label)}</span><div class="refbd">'
                + "".join(
                    f'<p class="{kind}">{esc(block)}</p>' if kind else f"<p>{esc(block)}</p>"
                    for kind, block in split_sn_answer(number, answer["text"])
                )
                + "</div>"
            )
        note = (
            "本题官方答案册提供两份参考答案，均按原册保留。"
            if number == 3
            else ""
        )
        question_cards.append(
            f'<div class="shen" id="sq{number}"><div class="qh">申论 · 第 {number} 题</div>'
            f'<p class="stem">{esc(demand)}</p>'
            '<details class="ansbox"><summary><span class="mtag ans">参考答案</span>'
            "点击查看参考答案与评分标准</summary><div class=\"ref\">"
            + "".join(answer_parts)
            + "</div></details>"
            + (f'<div class="bannote">{esc(note)}</div>' if note else "")
            + f'<div class="note">来源：{esc(DISPLAY)} · 申论 · 第 {number} 题</div>'
            + "</div>"
        )

    intro = (
        "本次申论为向尚教育2027年寄宿制强化卷三（四川卷），题本共10页，"
        "给定资料5则、作答要求5题。题面已逐页文字化，参考答案4页已分题录入；"
        "第三题保留原册两份工作简报，第五题保留完整参考范文。"
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
            '  <div class="meta"><span>题本10页</span><span>材料5则</span>'
            "<span>作答5题</span><span>参考答案4页</span>"
            "<span>第三题两份答案</span></div>",
            "</header>",
            '<div class="subnav">',
            '  <a href="../../每周模考.html">← 模考中心</a>',
            '  <a href="行测.html">行测</a>',
            '  <a class="on" href="申论.html">申论</a>',
            '  <a href="行测错题集合.html">行测错题集合</a>',
            '  <a href="成绩分析.html">成绩分析</a>',
            "</div>",
            '<div class="toolbar">',
            '  <input id="q" placeholder="搜索材料、题目或参考答案关键词…">',
            '  <span class="hitcount" id="hitcount"></span>',
            '  <button class="btn" id="hideans">展开全部答案</button>',
            "</div>",
            '<div class="wrap">',
            '<div class="module" id="cailiao"><div class="mod-banner">'
            "<h2>给定资料</h2><p>材料1～材料5</p>"
            '<span class="num">5则</span></div><div class="mod-body">',
            "".join(material_cards),
            "</div></div>",
            '<div class="module" id="zuoda"><div class="mod-banner">'
            "<h2>作答要求</h2><p>概括 · 词句理解 · 工作简报 · 对策 · 大作文</p>"
            '<span class="num">5题</span></div><div class="mod-body">',
            "".join(question_cards),
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
            if not 1 <= number <= 130:
                raise ValueError(f"作答题号越界：{number}")
            if number in answers:
                raise ValueError(f"作答题号重复：{number}")
            answers[number] = letter
    return answers


def module_for(number: int) -> tuple[str, str]:
    for name, slug, start, end, _ in MODULES:
        if start <= number <= end:
            return name, slug
    raise ValueError(f"题号不在模块范围：{number}")


def knowledge_point(number: int) -> str:
    if 36 <= number <= 50:
        return "言语理解—逻辑填空"
    if 51 <= number <= 58 or 61 <= number <= 65:
        return "言语理解—片段阅读"
    if 59 <= number <= 60:
        return "言语理解—语句排序"
    if 66 <= number <= 75:
        return "数量关系—数学运算"
    if 76 <= number <= 85:
        return "判断推理—图形推理"
    if 86 <= number <= 95:
        return "判断推理—定义判断"
    if 96 <= number <= 100:
        return "判断推理—类比推理"
    if 101 <= number <= 110:
        return "判断推理—逻辑判断"
    if 111 <= number <= 130:
        return "资料分析—统计材料"
    name, _ = module_for(number)
    return name


def figure_alt(number: int) -> str:
    if number == 74:
        return "第74题题干示意图及A至D四个坐标图选项（保留卷面原图）"
    if number == 111:
        return "第111题A至D四张饼图选项（保留卷面原图）"
    if number in {82, 83}:
        return f"第{number}题六个图形（保留卷面原图）"
    if number == 84:
        return "第84题四个正方体展开图选项（保留卷面原图）"
    if number == 85:
        return "第85题立体图形及其四个选项（保留卷面原图）"
    return f"第{number}题图形及A至D选项（保留卷面原图）"


def review_question_card(
    number: int,
    mine: str,
    correct: str,
    label: str,
    questions: dict,
    answers: dict,
    images: dict,
    slug_override: str | None = None,
) -> str:
    key = str(number)
    section, slug = module_for(number)
    if slug_override:
        slug = slug_override
    source = questions[key]
    override = Q_OVERRIDES.get(key, {})
    stem = override.get("stem", source["stem"])
    options = override.get("options", source["options"])
    parts = [
        f'<div class="qcard" id="cat-{slug}-q{number}">',
        f'<div class="qhead">{esc(section)} · 第 {number} 题</div>',
        stem_html(stem),
    ]
    if key in FIG_IMAGES:
        parts.append(img_html(images, FIG_IMAGES[key], figure_alt(number)))
    parts.append(options_html(options))
    result_text = "不确定但选对了" if mine == correct else "做错"
    parts.append(
        '<div class="mine"><span class="ans-tag">我的答案</span><b>'
        + esc(mine)
        + f'</b><span class="todo">（{esc(result_text)}）</span></div>'
    )
    parts.append(
        '<div class="ansline"><span class="ans-tag">正确答案</span><b>'
        + esc(correct)
        + "</b></div>"
    )
    parts.append(
        '<div class="rtags"><span class="kp-tag">考点：'
        + esc(knowledge_point(number))
        + '</span><span class="rtag">'
        + ("蒙对：需要回做并写清依据" if mine == correct else "错因：待复盘")
        + "</span></div>"
    )
    analysis = ANSWER_OVERRIDES.get(key, str(answers[key]["explanation"]))
    parts.append(
        '<div class="expline"><span class="exp-tag">官方解析</span>'
        f"<p>{esc(analysis)}</p></div>"
    )
    parts.append(
        f'<div class="note">来源：{esc(DISPLAY)} · 行测 · {esc(section)} · '
        f"{label} · 第 {number} 题</div></div>"
    )
    return "".join(parts)


def review_material(prefix: str, group: str, images: dict) -> str:
    if group == "106":
        return material_card(
            f"{prefix}-mat-106-110",
            "第106～110题共用题干",
            "办公楼楼层安排",
            MAT_106,
        )
    if group == "111":
        return material_card(
            f"{prefix}-mat-111-115",
            "资料一",
            "回答111～115题",
            MAT_111,
        )
    if group == "116":
        return material_card(
            f"{prefix}-mat-116-120",
            "资料二",
            "回答116～120题",
            MAT_116,
            img_html(
                images,
                "资料分析/mat116-chart.jpg",
                "2015至2021年一季度中国电子商务交易总额及同比增速",
                "图　2015-2021年一季度中国电子商务交易总额及同比增速",
            ),
        )
    if group == "121":
        return material_card(
            f"{prefix}-mat-121-125",
            "资料三",
            "回答121～125题",
            MAT_121,
            img_html(
                images,
                "资料分析/mat121-table.jpg",
                "2021年H市全国12315平台接收投诉问题的受理量情况表",
                "表　2021年H市全国12315平台接收投诉问题的受理量情况",
            ),
        )
    if group == "126":
        return material_card(
            f"{prefix}-mat-126-130",
            "资料四",
            "回答126～130题",
            MAT_126,
            img_html(
                images,
                "资料分析/mat126-chart.jpg",
                "2016年至2022年3月我国苜蓿干草进口量及同比增速",
                "图　2016-2022年3月我国苜蓿干草进口情况",
            ),
        )
    raise ValueError(f"未知共用材料组：{group}")


def build_review_page(
    questions: dict,
    answers: dict,
    images: dict,
    script_tag: str,
) -> tuple[str, dict[int, str], list[int], list[int]]:
    user_answers = parse_user_answers(USER_RESPONSE_RAW)
    wrong: list[int] = []
    lucky: list[int] = []
    for number, mine in sorted(user_answers.items()):
        if mine == answers[str(number)]["answer"]:
            lucky.append(number)
        else:
            wrong.append(number)

    module_cards: list[str] = []
    toc: list[str] = []
    wrong_materials = {
        107: "106",
        118: "116",
        121: "121",
        126: "126",
    }
    for name, slug, start, end, subtitle in MODULES:
        numbers = [number for number in wrong if start <= number <= end]
        if not numbers:
            continue
        toc.append(
            f'<a class="t-cat" href="#cat-{slug}"><span class="dot"></span>'
            f"<b>{esc(name)}</b><i>{len(numbers)} 题</i></a>"
        )
        body = []
        for number in numbers:
            if number in wrong_materials:
                body.append(
                    review_material("wrong", wrong_materials[number], images)
                )
            body.append(
                review_question_card(
                    number,
                    user_answers[number],
                    answers[str(number)]["answer"],
                    "错题",
                    questions,
                    answers,
                    images,
                )
            )
        module_cards.append(
            f'<div class="module" id="cat-{slug}"><div class="mod-banner">'
            f"<h2>{esc(name)}</h2><p>{esc(subtitle)}</p>"
            f'<span class="num">{len(numbers)} 道错题</span></div>'
            f'<div class="mod-body">{"".join(body)}</div></div>'
        )

    if lucky:
        toc.append(
            f'<a class="t-cat" href="#cat-bqd"><span class="dot"></span>'
            f"<b>蒙对题</b><i>{len(lucky)} 题</i></a>"
        )
        lucky_materials = {
            110: "106",
            113: "111",
            119: "116",
            128: "126",
        }
        lucky_body = []
        for number in lucky:
            if number in lucky_materials:
                lucky_body.append(
                    review_material("lucky", lucky_materials[number], images)
                )
            lucky_body.append(
                review_question_card(
                    number,
                    user_answers[number],
                    answers[str(number)]["answer"],
                    "蒙对题",
                    questions,
                    answers,
                    images,
                    slug_override="bqd",
                )
            )
        module_cards.append(
            '<div class="module" id="cat-bqd"><div class="mod-banner">'
            "<h2>不确定但选对</h2><p>答案命中，但解题依据不稳定，按潜在错题复习</p>"
            f'<span class="num">{len(lucky)} 题</span></div>'
            f'<div class="mod-body">{"".join(lucky_body)}</div></div>'
        )

    head = extract_head(
        TEMPLATE_XC,
        f"{DISPLAY} · 行测错题集合 · 公考工作站",
        "mock1113-ct",
    )
    intro = (
        f"本次作答清单共{len(user_answers)}道：做错{len(wrong)}道，"
        f"不确定但选对{len(lucky)}道。错题按六大板块分置，蒙对题单列；"
        "正式成绩、用时和每题耗时尚未提供，不据此推算总分或排名。"
    )
    body = "\n".join(
        [
            "<!DOCTYPE html>",
            '<html lang="zh-CN" data-theme="mock">',
            head,
            "<body>",
            "<header>",
            f"  <h1>{esc(DISPLAY)} · 行测错题集合</h1>",
            f'  <div class="intro">{esc(intro)}</div>',
            f'  <div class="meta"><span>{len(user_answers)}条作答</span>'
            f"<span>{len(wrong)}道错题</span><span>{len(lucky)}道蒙对</span>"
            "<span>六大板块分置</span><span>正式成绩待补</span></div>",
            "</header>",
            subnav("行测错题集合"),
            '<div class="toolbar">',
            '  <input id="q" placeholder="搜索错题题号、题干或考点…">',
            '  <span class="hitcount" id="hitcount"></span>',
            "</div>",
            '<div class="layout">',
            f'  <nav class="toc" id="toc">{"".join(toc)}</nav>',
            '  <main id="main">',
            f'<div class="bannote">清单口径：{len(wrong)}道做错、'
            f"{len(lucky)}道蒙对；“蒙对题”虽然答案正确，仍应遮住答案重做，"
            "确认不是排除法和选项分布带来的偶然命中。错因与复习记录暂留空，"
            "不替用户编造。</div>",
            "".join(module_cards),
            "  </main>",
            "</div>",
            '<button class="backtop" id="backtop" title="回到顶部">↑</button>',
            script_tag,
            "</body>",
            "</html>",
        ]
    )
    return body, user_answers, wrong, lucky


def subnav(active: str) -> str:
    links = [
        ("行测", "行测.html"),
        ("申论", "申论.html"),
        ("行测错题集合", "行测错题集合.html"),
        ("成绩分析", "成绩分析.html"),
    ]
    return (
        '<div class="subnav"><a href="../../每周模考.html">← 模考中心</a>'
        + "".join(
            f'<a{" class=\"on\"" if label == active else ""} href="{href}">{label}</a>'
            for label, href in links
        )
        + "</div>"
    )


def build_placeholder(
    template: Path,
    active: str,
    local_id: str,
    intro: str,
    meta: list[str],
    card: str,
    script_tag: str,
) -> str:
    head = extract_head(
        template,
        f"{DISPLAY} · {active} · 公考工作站",
        local_id,
    )
    id_match = re.search(r'\bid="([^"]+)"', card)
    if not id_match:
        raise ValueError("占位页卡片缺少 id")
    toc_target = id_match.group(1)
    content = "\n".join(
        [
            "<!DOCTYPE html>",
            '<html lang="zh-CN" data-theme="mock">',
            head,
            "<body>",
            "<header>",
            f"  <h1>{esc(DISPLAY)} · {esc(active)}</h1>",
            f'  <div class="intro">{esc(intro)}</div>',
            '  <div class="meta">' + "".join(f"<span>{esc(item)}</span>" for item in meta) + "</div>",
            "</header>",
            subnav(active),
            '<div class="layout">',
            f'<nav class="toc" id="toc"><a class="t-cat" href="#{toc_target}"><span class="dot"></span>'
            "<b>待录入</b><i>—</i></a></nav>",
            '<main id="main">',
            card,
            "</main>",
            "</div>",
            '<button class="backtop" id="backtop" title="回到顶部">↑</button>',
            script_tag,
            "</body>",
            "</html>",
        ]
    )
    return content


def register_period(wrong_count: int, lucky_count: int) -> None:
    hub_path = SITE / "sections" / "每周模考.html"
    index_path = SITE / "index.html"
    hub = read(hub_path)
    index = read(index_path)
    description = (
        "2026年11月13日第18期：行测提升卷四，30页、130题，政治理论20题、"
        "常识判断15题、言语理解与表达30题、数量关系10题、判断推理35题、"
        "资料分析20题；题干、选项与四组资料已文字化，图形推理76～85题、"
        "第74题坐标图选项、第111题饼图及三组资料图表保留卷面原图。"
        "官方答案版27页的130题答案与解析已全部录入，算式已按页图重排。"
        "申论为强化卷三（四川卷），题本10页、材料5则、作答5题，"
        "参考答案4页已分题录入，第三题保留两份工作简报，第五题保留完整范文。"
        f"用户作答清单已与官方答案逐题核对，得到{wrong_count}道错题和"
        f"{lucky_count}道不确定但选对，已按六大板块生成错题集合并单列蒙对题。"
        "本次未提供正式成绩表，不推算总分、模块得分率或排名。"
    )
    hub_item = (
        "  { t:'11月13日模考', name:'提升卷四（11月13日模考）', no:'第 18 期', "
        "state:'行测130题 + 官方答案解析27页 + "
        f"{wrong_count}道错题 / {lucky_count}道蒙对 + 申论10页题本与4页参考答案已录入 · "
        "成绩待补', "
        f"desc:'{description}', "
        "qc:'130题 · 官方答案解析27页 · 已全部录入', "
        "sc:'题本10页 · 材料5则 · 5大题 · 参考答案4页', "
        f"cc:'{wrong_count} 道错题 + {lucky_count} 道蒙对 · 合并六板块', "
        "cj:'待正式成绩表' },\n"
    )
    index_item = (
        "{ id:'mk-261113', name:'提升卷四（11月13日模考）', en:'2026-11-13', "
        "file:'sections/每周模考.html', color:'#f43f5e', "
        f"sub:'行测130题 + {wrong_count}道错题 + {lucky_count}道蒙对 · "
        "申论10页题本 + 4页参考答案 · 成绩待补', cnt:'第 18 期', "
        f"desc:'{description}', hit:'11月13日模考', "
        "keywords:['11月13日','11月13日模考','提升卷四','提升卷四申论',"
        "'强化卷三','四川卷','第十八期','第18期','模考','行测','申论','130题',"
        "'题本','答案','解析','官方答案版','参考答案','评分标准','参考范文',"
        "'政治理论','常识判断','言语理解','数量关系','判断推理','资料分析',"
        "'图形推理','食安小站','沙盒监管','益·峨眉','社区矫正','12315',"
        f"'苜蓿干草','法理情理为经纬','{wrong_count}道错题','{lucky_count}道蒙对',"
        "'错题集合','蒙对题'] },\n"
    )

    hub_pattern = r"(?m)^  \{ t:'11月13日模考'.*? \},\r?$"
    index_pattern = r"(?m)^\{ id:'mk-261113'.*? \},\r?$"
    hub_matches = len(re.findall(hub_pattern, hub))
    index_matches = len(re.findall(index_pattern, index))
    if hub_matches == 1 and index_matches == 1:
        hub = re.sub(hub_pattern, lambda _: hub_item.rstrip("\n"), hub, count=1)
        index = re.sub(
            index_pattern, lambda _: index_item.rstrip("\n"), index, count=1
        )
        action = "updated"
    elif hub_matches == 0 and index_matches == 0:
        anchor = "  { t:'10月31日模考'"
        if hub.count(anchor) != 1:
            raise ValueError("模考中心期次锚点异常")
        hub = hub.replace(anchor, hub_item + anchor, 1)
        anchor = "{ id:'mk-261031'"
        if index.count(anchor) != 1:
            raise ValueError("首页期次锚点异常")
        index = index.replace(anchor, index_item + anchor, 1)
        action = "inserted"
    else:
        raise ValueError(
            f"期次登记不一致：hub={hub_matches}, index={index_matches}"
        )
    if "cnt:'18 期'" not in index:
        if index.count("cnt:'17 期'") != 1:
            raise ValueError("期次总数锚点异常")
        index = index.replace("cnt:'17 期'", "cnt:'18 期'", 1)
    write(hub_path, hub)
    write(index_path, index)
    print(f"registered=第 18 期 ({action}, wrong={wrong_count}, lucky={lucky_count})")


def update_search_fixtures() -> None:
    path = SITE / "scripts" / "search-fixtures.json"
    payload = json.loads(read(path))
    additions = [
        {
            "q": "提升卷四",
            "expect": {"min": 1, "section": "mk-261113"},
            "why": "第18期模考展示名",
        },
        {
            "q": "食安小站",
            "expect": {"min": 1, "section": "mk-261113"},
            "why": "第18期申论材料一专名",
        },
        {
            "q": "益·峨眉",
            "expect": {"min": 1, "section": "mk-261113"},
            "why": "第18期申论材料三与第三题",
        },
        {
            "q": "苜蓿干草",
            "expect": {"min": 1, "section": "mk-261113"},
            "why": "第18期行测资料分析材料四",
        },
        {
            "q": "11月13日错题",
            "expect": {"min": 1, "section": "mk-261113"},
            "why": "第18期错题集合与蒙对题清单",
        },
    ]
    if not isinstance(payload, dict) or not isinstance(payload.get("queries"), list):
        raise ValueError("search-fixtures.json 结构异常")
    existing = {
        item.get("q") for item in payload["queries"] if isinstance(item, dict)
    }
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
        raise ValueError("题本不是完整1～130题")
    if sorted(map(int, answers)) != list(range(1, 131)):
        raise ValueError("答案不是完整1～130题")

    images = convert_assets()
    script_tag = final_script(TEMPLATE_XC)
    write(
        OUTPUT / "行测.html",
        build_exam_page(questions, answers, images, script_tag),
    )
    write(OUTPUT / "申论.html", build_shenlun_page(script_tag))

    review_html, user_answers, wrong, lucky = build_review_page(
        questions, answers, images, script_tag
    )
    write(
        OUTPUT / "行测错题集合.html",
        review_html,
    )
    score_card = (
        '<section class="scard" id="cj-todo"><h2>成绩分析 <em>待正式成绩表</em></h2>'
        '<p class="lead">本次未提供行测、申论成绩表或排名数据，不推算分数、模块得分率与排名。</p>'
        "<p>收到正式成绩后，可按模块正确率、班级均分、年级排名和目标分差补做复盘。</p></section>"
    )
    write(
        OUTPUT / "成绩分析.html",
        build_placeholder(
            TEMPLATE_SN,
            "成绩分析",
            "mock1113-cj",
            "已收到错题和蒙对作答清单，但尚无正式成绩表；成绩分析仍保留待录入。",
            [
                f"{len(wrong)}道错题",
                f"{len(lucky)}道蒙对",
                "正式成绩待补",
                "排名待补",
            ],
            score_card,
            final_script(TEMPLATE_XC),
        ),
    )
    register_period(len(wrong), len(lucky))
    update_search_fixtures()
    print(f"built={OUTPUT}")
    print(
        f"review listed={len(user_answers)} wrong={len(wrong)} lucky={len(lucky)}"
    )


if __name__ == "__main__":
    main()
