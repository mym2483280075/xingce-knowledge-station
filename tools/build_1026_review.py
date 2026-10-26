from __future__ import annotations

import copy
import re
from collections import Counter, OrderedDict
from pathlib import Path

from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]
PERIOD = ROOT / "sections" / "每周模考" / "10月26日模考"
SOURCE = PERIOD / "行测.html"
WRONG_TEMPLATE = (
    ROOT / "sections" / "每周模考" / "10月17日模考" / "行测错题集合.html"
)
ANALYSIS_TEMPLATE = (
    ROOT / "sections" / "每周模考" / "10月17日模考" / "成绩分析.html"
)
WRONG_OUTPUT = PERIOD / "行测错题集合.html"
ANALYSIS_OUTPUT = PERIOD / "成绩分析.html"

RAW_USER_ANSWERS = """
2c,4d,5b,9,d,10a,11c,12a,13c,14b,17d,18a,19d,20a,28d,29b,31d,32c,
33a,34d,37c,38c,40d,43a,44c,45c,46c,47c,48c,49a,50c,51到60均为c,
61b,65c,66c,67c,68c,69c,70b,74a,77d,78c,80b,81c,82c,84a,87d,92c,
98d,99c,100c,103d,112b
"""

MODULES = [
    {
        "key": "zz",
        "name": "政治理论",
        "lo": 1,
        "hi": 10,
        "unit": 0.8,
        "subtitle": "习思想 · 马克思主义基本原理",
    },
    {
        "key": "cs",
        "name": "常识判断",
        "lo": 11,
        "hi": 20,
        "unit": 0.8,
        "subtitle": "文史 · 科技 · 经济 · 地理 · 法律",
    },
    {
        "key": "yy",
        "name": "言语理解",
        "lo": 21,
        "hi": 50,
        "unit": 0.8,
        "subtitle": "逻辑填空 · 片段阅读 · 语句表达",
    },
    {
        "key": "sl",
        "name": "数量关系",
        "lo": 51,
        "hi": 60,
        "unit": 0.9,
        "subtitle": "数学运算 · 速算",
    },
    {
        "key": "pd",
        "name": "判断推理",
        "lo": 61,
        "hi": 100,
        "unit": None,
        "subtitle": "图形 · 定义 · 类比 · 逻辑",
    },
    {
        "key": "zl",
        "name": "资料分析",
        "lo": 101,
        "hi": 120,
        "unit": 0.9,
        "subtitle": "统计材料 · 图表 · 速算",
    },
]

JUDGMENT_PARTS = [
    ("图形推理", 61, 70, 0.9),
    ("定义判断", 71, 80, 0.8),
    ("类比推理", 81, 90, 0.7),
    ("逻辑判断", 91, 100, 0.9),
]

SCORING_PARTS = [
    ("政治理论", 1, 10, 0.8),
    ("常识判断", 11, 20, 0.8),
    ("言语理解", 21, 50, 0.8),
    ("数量关系", 51, 60, 0.9),
    ("图形推理", 61, 70, 0.9),
    ("定义判断", 71, 80, 0.8),
    ("类比推理", 81, 90, 0.7),
    ("逻辑判断", 91, 100, 0.9),
    ("资料分析", 101, 120, 0.9),
]


def parse_user_answers(raw: str) -> OrderedDict[int, str]:
    normalized = re.sub(r"\s+", "", raw)
    normalized = normalized.replace("9,d", "9d")
    result: OrderedDict[int, str] = OrderedDict()
    for part in normalized.split(","):
        if not part:
            continue
        match = re.fullmatch(r"(\d+)([A-D])", part, flags=re.I)
        if match:
            result[int(match.group(1))] = match.group(2).upper()
            continue
        match = re.fullmatch(r"(\d+)到(\d+)均为([A-D])", part, flags=re.I)
        if match:
            for number in range(int(match.group(1)), int(match.group(2)) + 1):
                result[number] = match.group(3).upper()
            continue
        raise ValueError(f"无法识别作答片段：{part}")
    return OrderedDict(sorted(result.items()))


def extract_head(template: Path, title: str) -> str:
    text = template.read_text(encoding="utf-8")
    head = re.search(r"<head>(.*?)</head>", text, flags=re.S)
    if not head:
        raise ValueError(f"模板缺少 head：{template}")
    content = head.group(1)
    content = re.sub(
        r"<title>.*?</title>",
        f"<title>{title}</title>",
        content,
        count=1,
        flags=re.S,
    )
    content = content.replace('id="mock17-local"', 'id="mock26-local"')
    return f"<head>{content}</head>"


def qtext(q: int) -> str:
    return f"q{q:03d}"


def category_qid(module_key: str, q: int) -> str:
    return f"cat-{module_key}-q{q}"


def section_for_question(q: int) -> tuple[str, float]:
    for name, lo, hi, unit in SCORING_PARTS:
        if lo <= q <= hi:
            return name, unit
    raise ValueError(q)


def find_module(q: int) -> dict:
    for module in MODULES:
        if module["lo"] <= q <= module["hi"]:
            return module
    raise ValueError(q)


def make_tag(soup: BeautifulSoup, tag_name: str, css: str, text: str):
    node = soup.new_tag(tag_name)
    node["class"] = css
    node.string = text
    return node


def build_review_card(
    source_soup: BeautifulSoup,
    q: int,
    user_answer: str,
    official_answer: str,
) -> str:
    original = source_soup.select_one(f'div.qcard[id="{qtext(q)}"]')
    if original is None:
        raise ValueError(f"题本缺少第 {q} 题")
    card_soup = BeautifulSoup(str(original), "lxml")
    card = card_soup.select_one("div.qcard")
    module = find_module(q)
    section, _ = section_for_question(q)
    lucky = user_answer == official_answer
    card["id"] = category_qid(module["key"], q)

    note = card.select_one("div.note")
    if note is not None:
        note.extract()

    ansbox = card.select_one("details.ansbox")
    if ansbox is None:
        raise ValueError(f"第 {q} 题缺少答案")
    ansline = ansbox.select_one("div.ansline")
    expline = ansbox.select_one("div.expline")
    if ansline is None or expline is None:
        raise ValueError(f"第 {q} 题缺少答案或解析")
    ansline = copy.deepcopy(ansline)
    expline = copy.deepcopy(expline)
    if q == 65:
        ansbody = expline.select_one(".ansbody")
        if ansbody is None:
            raise ValueError("第 65 题缺少解析正文")
        ansbody.clear()
        paragraph = card_soup.new_tag("p")
        paragraph.string = (
            "元素组成不同，且无明显属性规律，优先考虑数量规律。"
            "观察发现，题干图形被分割，空白封闭区域明显，考虑数面；"
            "整体数面没有规律，进一步考虑面的细化。题干图形均含有最大面，"
            "且最大面均为轴对称图形，故问号处应选择一个最大面为轴对称图形的图形，"
            "只有 B 项符合。故正确答案为 B。"
        )
        ansbody.append(paragraph)
    label = ansline.select_one(".ans-tag")
    if label is not None:
        label.string = "正确答案"
    ansbox.extract()

    mine = card_soup.new_tag("div")
    mine["class"] = "mine"
    mine.append(make_tag(card_soup, "span", "ans-tag", "我的答案"))
    mine.append(make_tag(card_soup, "b", "", user_answer))
    if lucky:
        todo = make_tag(card_soup, "span", "todo", " · 不确定但答对")
        mine.append(todo)
    card.append(mine)
    card.append(ansline)

    tags = card_soup.new_tag("div")
    tags["class"] = "rtags"
    tags.append(make_tag(card_soup, "span", "kp-tag", f"考点：{section}"))
    if lucky:
        tags.append(
            make_tag(card_soup, "span", "rtag", "蒙对：当时为什么不确定？")
        )
        tags.append(make_tag(card_soup, "span", "rtag", "复盘：待填写"))
    else:
        tags.append(make_tag(card_soup, "span", "rtag", "错因：待复盘"))
    card.append(tags)
    card.append(expline)

    note = card_soup.new_tag("div")
    note["class"] = "note"
    note.string = f"来源：10月26日模考 · 行测 · {section} · 第 {q} 题"
    card.append(note)
    return str(card)


def build_cloned_material(source_soup: BeautifulSoup, mat_id: str) -> str:
    material = source_soup.select_one(f'div.matcard[id="{mat_id}"]')
    if material is None:
        raise ValueError(f"缺少材料卡：{mat_id}")
    clone = BeautifulSoup(str(material), "lxml").select_one("div.matcard")
    return str(clone)


def build_wrong_page(
    source_soup: BeautifulSoup,
    user: OrderedDict[int, str],
    answers: dict[int, str],
    stats: list[dict],
) -> str:
    wrong = {q for q, answer in user.items() if answers[q] != answer}
    lucky = {q for q, answer in user.items() if answers[q] == answer}
    assert len(user) == 61
    assert len(wrong) == 49
    assert len(lucky) == 12

    selected_counts = OrderedDict(
        (module["key"], sum(module["lo"] <= q <= module["hi"] for q in user))
        for module in MODULES
    )
    toc_items = []
    module_html = []
    for module in MODULES:
        count = selected_counts[module["key"]]
        toc_items.append(
            f'<a class="t-cat" href="#cat-{module["key"]}">'
            f'<span class="dot"></span><b>{module["name"]}</b><i>{count} 题</i></a>'
        )
        questions = [q for q in user if module["lo"] <= q <= module["hi"]]
        if not questions:
            continue
        body_parts = [
            f'<div class="pintro">本模块共 {count} 道标记题；'
            f'其中做错 {sum(q in wrong for q in questions)} 道，'
            f'不确定但选对 {sum(q in lucky for q in questions)} 道。</div>'
        ]
        if module["key"] == "zl":
            if any(101 <= q <= 105 for q in questions):
                body_parts.append(build_cloned_material(source_soup, "mat-101-105"))
            if any(111 <= q <= 115 for q in questions):
                body_parts.append(build_cloned_material(source_soup, "mat-111-115"))
        if module["key"] == "pd":
            for part_name, lo, hi, _ in JUDGMENT_PARTS:
                part_questions = [q for q in questions if lo <= q <= hi]
                if not part_questions:
                    continue
                body_parts.append(
                    '<div class="subhead">'
                    f'<b>{part_name}</b><span>{len(part_questions)} 道标记题</span>'
                    "</div>"
                )
                for q in part_questions:
                    body_parts.append(
                        build_review_card(source_soup, q, user[q], answers[q])
                    )
        else:
            for q in questions:
                body_parts.append(build_review_card(source_soup, q, user[q], answers[q]))
        module_html.append(
            f'<div class="module" id="cat-{module["key"]}">'
            '<div class="mod-banner">'
            f'<h2>{module["name"]}<span class="w">复盘</span></h2>'
            f'<p>{module["subtitle"]}</p><span class="num">{count} 题</span>'
            "</div>"
            f'<div class="mod-body">{"".join(body_parts)}</div></div>'
        )

    wrong_by_module = "、".join(
        f'{item["name"]} {item["wrong"]}' for item in stats if item["wrong"]
    )
    lucky_by_module = "、".join(
        f'{item["name"]} {item["lucky"]}' for item in stats if item["lucky"]
    )
    head = extract_head(
        WRONG_TEMPLATE,
        "提升卷一（10月26日） · 行测错题集合 · 公考工作站",
    )
    body = f"""
<body>
<header>
  <h1>提升卷一（10月26日） · 行测错题集合</h1>
  <div class="intro">本次作答标记共 61 题：49 道做错，12 道“当时不确定但选对”。按六大板块合并展示，每题保留我的答案、官方正确答案、考点与官方解析；蒙对题在卡内单独标注。</div>
  <div class="meta"><span>49 道错题</span><span>12 道蒙对</span><span>61 道标记题</span><span>官方答案逐题核对</span></div>
</header>
<div class="subnav">
  <a href="../../每周模考.html">← 模考中心</a>
  <a href="行测.html">行测</a>
  <a href="申论.html">申论</a>
  <a class="on" href="行测错题集合.html">行测错题集合</a>
  <a href="成绩分析.html">成绩分析</a>
</div>
<div class="toolbar">
  <input id="q" placeholder="搜索本页错题、考点或解析，回车定位…">
  <span class="hitcount" id="hitcount"></span>
  <button class="btn" id="hideans">隐藏正确与复盘</button>
</div>
<div class="layout">
  <nav class="toc" id="toc">{''.join(toc_items)}</nav>
  <main id="main">
    <div class="bannote">口径提示：清单中的“我的答案”按原记录录入；原文“9,d”按“第 9 题选 D”处理。标记题中，数量关系 51～60 全部选 C，仅第 59 题命中；全部 61 条标记答案里 C 有 33 条，其中 29 条做错，说明“不会就选 C”是本次最明显的失分入口。做错题分布：{wrong_by_module}。蒙对题分布：{lucky_by_module}。</div>
    {''.join(module_html)}
  </main>
</div>
<button class="backtop" id="backtop" title="回到顶部">↑</button>
<script src="../../../assets/%E6%9D%BF%E5%9D%97%E9%A1%B5%E8%84%9A%E6%9C%AC.js?v=0cbebb75"></script>
</body>
</html>
"""
    return "<!DOCTYPE html>\n<html lang=\"zh-CN\" data-theme=\"mock\">\n" + head + body


def build_analysis_page(
    user: OrderedDict[int, str],
    answers: dict[int, str],
    stats: list[dict],
    total_score: float,
) -> str:
    wrong = sorted(q for q, answer in user.items() if answers[q] != answer)
    lucky = sorted(q for q, answer in user.items() if answers[q] == answer)
    correct_count = 120 - len(wrong)
    user_letters = Counter(user.values())
    wrong_user_letters = Counter(user[q] for q in wrong)
    wrong_official_letters = Counter(answers[q] for q in wrong)
    sorted_stats = sorted(
        stats,
        key=lambda item: (-item["rate"], MODULES.index(find_module(item["lo"]))),
    )

    table_rows = []
    for item in sorted_stats:
        rate_class = "ok" if item["rate"] >= 80 else "mid" if item["rate"] >= 50 else ""
        if item["rate"] >= 80:
            score_class = "ok"
            tag_class = "ok"
            tag_text = "稳定"
        elif item["rate"] >= 60:
            score_class = ""
            tag_class = "mid"
            tag_text = "可提升"
        else:
            score_class = "bad"
            tag_class = "bad"
            tag_text = "优先补"
        table_rows.append(
            "<tr>"
            f'<td class="nm">{item["name"]}</td>'
            f'<td class="num">{item["max"]:.1f}</td>'
            f'<td class="num d {score_class}">{item["score"]:.1f}</td>'
            f'<td><div class="bar {rate_class}"><i style="width:{item["rate"]:.1f}%"></i></div>'
            f'<span class="rate">{item["rate"]:.1f}%</span></td>'
            f'<td class="num">{item["correct"]} / {item["total"]}</td>'
            f'<td class="num">{item["wrong"]}</td>'
            f'<td class="num">{item["lucky"]}</td>'
            f'<td><span class="tag {tag_class}">{tag_text}</span></td>'
            "</tr>"
        )

    module_lists = []
    for item in stats:
        wrong_list = [q for q in wrong if item["lo"] <= q <= item["hi"]]
        lucky_list = [q for q in lucky if item["lo"] <= q <= item["hi"]]
        wrong_text = "、".join(map(str, wrong_list)) or "无"
        lucky_text = "、".join(map(str, lucky_list)) or "无"
        module_lists.append(
            '<div class="wrow">'
            f'<div class="wn">{item["name"]}<i>{item["score"]:.1f} / {item["max"]:.1f}</i></div>'
            f'<div class="wd"><b>错题：</b>{wrong_text}<br><b>蒙对：</b>{lucky_text}</div>'
            "</div>"
        )

    head = extract_head(
        ANALYSIS_TEMPLATE,
        "提升卷一（10月26日） · 成绩分析 · 公考工作站",
    )
    body = f"""
<body>
<header>
  <h1>提升卷一（10月26日模考） · 行测作答复盘</h1>
  <div class="intro">本页依据你提供的“错题 + 不确定题 + 我的答案”清单，与站内官方 120 题答案逐题比对生成。未列出的题目按“作答正确且未标记不确定”计算；因此 59.1 分是作答清单反推值，不是成绩表原值。</div>
  <div class="meta"><span>反推 59.1 / 100</span><span>49 道做错</span><span>12 道蒙对</span><span>正确 71 / 120</span></div>
</header>
<div class="subnav">
  <a href="../../每周模考.html">← 模考中心</a>
  <a href="行测.html">行测</a>
  <a href="申论.html">申论</a>
  <a href="行测错题集合.html">行测错题集合</a>
  <a class="on" href="成绩分析.html">成绩分析</a>
  <a href="../../成绩档案.html">成绩档案 →</a>
</div>
<main>
  <section class="scard" id="cj-jielun">
    <h2>一句话结论 <em>按 61 条作答标记反推</em></h2>
    <p class="lead">本次反推 <b>59.1 / 100</b>，共做错 <b>49 题</b>，另有 <b>12 题</b>属于“不确定但选对”。真正的最大漏洞不在题量，而在数量关系：<b>10 题仅对 1 题，51～60 全部选 C，只有第 59 题命中</b>。其次是政治理论、常识判断、言语理解三块都只有 50%，图形推理 60%。资料分析 90%、类比推理 80% 是当前最稳的得分底盘。</p>
    <div class="kpis">
      <div class="kpi warn"><div class="k">作答清单反推分</div><div class="v">59.1<small>/ 100</small></div><div class="n">未列题默认答对且未犹豫</div></div>
      <div class="kpi warn"><div class="k">做错</div><div class="v">49<small>题</small></div><div class="n">官方答案逐题核对</div></div>
      <div class="kpi"><div class="k">不确定但选对</div><div class="v">12<small>题</small></div><div class="n">正确率有“蒙对水分”</div></div>
      <div class="kpi"><div class="k">正确题数</div><div class="v">71<small>/ 120</small></div><div class="n">全卷题数正确率 59.2%</div></div>
    </div>
  </section>

  <section class="scard" id="cj-zhenduan">
    <h2>四条诊断 <em>先看最值得动手的地方</em></h2>
    <div class="diag">
      <div class="ditem two"><b>① 数量关系是单点塌陷：1 / 10，只拿 0.9 / 9 分</b><p>51～60 全选 C，官方答案仅第 59 题为 C。这里不是“速度慢”，而是整块没有形成可稳定得分的题型入口。下一阶段先只练工程、行程、利润、和差倍比、基础排列组合五类，把目标放到稳定的 3 / 10，比继续全面铺开更有效。</p></div>
      <div class="ditem two"><b>② C 选项依赖明显：61 条标记答案里 33 条选 C</b><p>33 条 C 中只有 4 条选对，29 条做错；49 道错题的官方答案里 B 有 18 道、D 有 14 道。说明“不会就选 C”在本卷是一次系统性亏损，后续蒙题应按已排除项和选项分布处理，不能固定押一个字母。</p></div>
      <div class="ditem"><b>③ 基础题失分面较宽：政治、常识、言语都只有 50%</b><p>政治理论 5 / 10、常识判断 5 / 10、言语理解 15 / 30。三块合计丢掉 20 题，其中言语丢 15 题，说明这次不是某一个冷门知识点，而是基础知识覆盖与文段判断稳定性都不足。应优先复盘“明确知道却选错”和“两个选项排不掉”的题，不要只记答案。</p></div>
      <div class="ditem good"><b>④ 已有可保底盘：资料 90%、类比 80%、定义 70%</b><p>资料分析 18 / 20、类比推理 8 / 10、定义判断 7 / 10，合计 28.6 / 33 分。维持每周少量回刷即可，时间和复盘精力应先转向数量、图形、政治和言语，而不是把已经稳定的板块继续堆题。</p></div>
    </div>
  </section>

  <section class="scard" id="cj-modules">
    <h2>九模块明细 <em>满分 100</em></h2>
    <p class="pintro">按得分率从高到低排列。单项配分为政治 8、常识 8、言语 24、数量 9、图形 9、定义 8、类比 7、逻辑 9、资料 18，合计 100 分；分值与本站 120 题模考的统一口径一致。</p>
    <div class="tblwrap"><table class="mod"><thead><tr><th>模块</th><th>满分</th><th>得分</th><th>得分率</th><th>正确题数</th><th>错题</th><th>蒙对</th><th>判断</th></tr></thead><tbody>{''.join(table_rows)}</tbody></table></div>
    <p class="tnote">校验：各模块正确题数相加为 {correct_count}，做错合计为 {len(wrong)}，蒙对合计为 {len(lucky)}，三项对应 120 题；九模块得分相加为 {total_score:.1f}。本页没有用时、涂卡顺序和成绩表位置，因此不做时间分配或排名归因。</p>
  </section>

  <section class="scard" id="cj-shibai">
    <h2>错题与蒙对清单 <em>直接回到题目</em></h2>
    <p class="pintro">下列题号均可在 <a href="行测错题集合.html">行测错题集合</a> 中按板块查看官方解析。“蒙对”表示你的答案与正确答案一致，但你在清单中标记为不确定。</p>
    {''.join(module_lists)}
  </section>

  <section class="scard" id="cj-bufen">
    <h2>补分路径 <em>先拿最容易回来的 6 分</em></h2>
    <ol class="plan">
      <li><b>第一步：数量先救 2 题（+1.8）。</b>不再十题全猜 C，限时 12 分钟只做五类基础题；不会的题先排除两个明显错误项，再随机选剩余项。目标 3 / 10。</li>
      <li><b>第二步：图形多拿 2 题（+1.8）。</b>把 65、66、67、69 分别归入位置、数量、对称、笔画、叠加、立体六类，至少做到看到题能先列三个优先规律。目标 8 / 10。</li>
      <li><b>第三步：政治与常识各回补 1 题（+1.6）。</b>政治优先修正“统筹发展和改革 / 安全”“根本任务 / 根本要求”“立法法 / 宪法”这类一词之差；常识按文史、科技、法律分开建错题标签。</li>
      <li><b>第四步：言语回补 1 题（+0.8）。</b>先做因果、转折、并列三类中心理解，再用逻辑填空的搭配和语境对应补第 2 题。以上四步合计约 +6.0，目标分数看向 65。</li>
      <li><b>保底盘：资料、类比、定义。</b>资料分析先复盘 103、112 两题，确认是计算位置还是概念判断；类比和定义用隔天回刷维持，不挤占数量与图形时间。</li>
    </ol>
    <div class="goal"><b>下一场最现实的分数线：</b>先把数量稳定到 3 题、图形稳定到 8 题，再回收政治/常识/言语各 1 题，目标 65 分左右。若数量能到 4 题、图形 8 题，再叠加言语基础回升，才有冲击 68–70 的条件。</div>
  </section>

  <section class="scard" id="cj-shuoming">
    <h2>数据口径与质量 <em>看结论前请先读</em></h2>
    <ul class="note">
      <li><b>答案来源</b>：站内 10 月 26 日提升卷一行测页已录入的官方 120 题答案与解析，逐题抓取并核对答案字母。</li>
      <li><b>作答来源</b>：用户本次提供的 61 条“错题 / 不确定题 + 我的答案”清单；“9,d”按第 9 题选 D 处理。</li>
      <li><b>反推假设</b>：没有列出的 59 题按答对且未标记不确定处理。若另有漏记的错题，实际分数会更低；因此 59.1 只作为复盘基线，不能替代正式成绩表。</li>
      <li><b>选项统计</b>：61 条标记作答中，C {user_letters['C']} 条、D {user_letters['D']} 条、A {user_letters['A']} 条、B {user_letters['B']} 条；49 道错题中，你选 C {wrong_user_letters['C']} 条，官方答案为 B {wrong_official_letters['B']} 条、D {wrong_official_letters['D']} 条。</li>
      <li><b>缺失信息</b>：没有用时、各题实际作答时间、答题卡涂写顺序和正式成绩表，因此不做涂错推断、不评价速度，也不与班级排名比较。</li>
      <li><b>复盘顺序</b>：先看数量与图形，再看政治/常识/言语；每题至少写一条错因，区分“知识缺口、概念混淆、条件看漏、计算失误、排除不彻底、纯蒙”。</li>
    </ul>
  </section>
</main>
<button class="backtop" id="bt" title="回到顶部">↑</button>
<script src="../../../assets/%E6%9D%BF%E5%9D%97%E9%A1%B5%E8%84%9A%E6%9C%AC.js?v=0cbebb75"></script>
<script>(function(){{var b=document.getElementById('bt');function f(){{if(b)b.classList.toggle('show',window.scrollY>500)}}window.addEventListener('scroll',f,{{passive:true}});if(b)b.addEventListener('click',function(){{window.scrollTo({{top:0,behavior:'smooth'}})}});}})();</script>
</body>
</html>
"""
    return "<!DOCTYPE html>\n<html lang=\"zh-CN\" data-theme=\"mock\">\n" + head + body


def build_stats(
    user: OrderedDict[int, str],
    answers: dict[int, str],
) -> tuple[list[dict], float]:
    wrong = {q for q, answer in user.items() if answers[q] != answer}
    lucky = {q for q, answer in user.items() if answers[q] == answer}
    stats = []
    total_score = 0.0
    for name, lo, hi, unit in SCORING_PARTS:
        total = hi - lo + 1
        wrong_count = sum(lo <= q <= hi for q in wrong)
        lucky_count = sum(lo <= q <= hi for q in lucky)
        correct = total - wrong_count
        score = correct * unit
        maximum = total * unit
        total_score += score
        stats.append(
            {
                "name": name,
                "lo": lo,
                "hi": hi,
                "unit": unit,
                "total": total,
                "correct": correct,
                "wrong": wrong_count,
                "lucky": lucky_count,
                "score": round(score, 10),
                "max": round(maximum, 10),
                "rate": correct / total * 100,
            }
        )
    return stats, round(total_score, 10)


def main() -> None:
    for path in (SOURCE, WRONG_TEMPLATE, ANALYSIS_TEMPLATE):
        if not path.exists():
            raise FileNotFoundError(path)

    user = parse_user_answers(RAW_USER_ANSWERS)
    source_text = SOURCE.read_text(encoding="utf-8")
    source_soup = BeautifulSoup(source_text, "lxml")
    answers = {
        int(match.group(1)): match.group(2)
        for match in re.finditer(
            r'<div class="qcard" id="q(\d{3})">.*?'
            r'<div class="ansline">.*?<b>([A-D])</b>',
            source_text,
            flags=re.S,
        )
    }
    if len(answers) != 120 or sorted(answers) != list(range(1, 121)):
        raise ValueError("官方答案没有完整覆盖 1–120 题")
    if len(user) != 61:
        raise ValueError(f"作答清单应为 61 条，实际 {len(user)} 条")
    if not set(user) <= set(answers):
        raise ValueError("存在超出题号范围的作答")

    stats, total_score = build_stats(user, answers)
    if round(total_score, 1) != 59.1:
        raise ValueError(f"分数校验失败：{total_score}")

    wrong_page = build_wrong_page(source_soup, user, answers, stats)
    WRONG_OUTPUT.write_text(wrong_page, encoding="utf-8")

    wrong_count = sum(1 for q, answer in user.items() if answers[q] != answer)
    lucky_count = len(user) - wrong_count
    print(f"已生成：{WRONG_OUTPUT}")
    print(
        "成绩分析页由正式成绩表与申论逐题分独立维护；"
        "本脚本不再覆盖 ANALYSIS_OUTPUT。"
    )
    print(
        f"核对通过：{len(user)} 条标记 = {wrong_count} 道错题 + "
        f"{lucky_count} 道蒙对；反推 {total_score:.1f} / 100"
    )


if __name__ == "__main__":
    main()
