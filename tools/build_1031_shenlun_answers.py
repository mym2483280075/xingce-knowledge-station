from __future__ import annotations

import html
import json
import os
import re
from pathlib import Path


SITE = Path(os.environ["AI_ROOT"]) / "Codex  Thing" / "xingce-knowledge-station"
PAGE = SITE / "sections" / "每周模考" / "10月31日模考" / "申论.html"
HUB = SITE / "sections" / "每周模考.html"
INDEX = SITE / "index.html"
FIXTURES = SITE / "scripts" / "search-fixtures.json"


def esc(value: str) -> str:
    return html.escape(value, quote=False)


def with_points(value: str) -> str:
    escaped = esc(value)
    return re.sub(r"(【[^】]*分】)", r'<b class="pt">\1</b>', escaped)


def answer_ref(label: str, body: str) -> str:
    return (
        f'<div class="ref"><span class="mtag ans">{esc(label)}</span>'
        f'<div class="refbd">{body}</div></div>'
    )


def paragraph(value: str, css_class: str = "") -> str:
    class_attr = f' class="{css_class}"' if css_class else ""
    return f"<p{class_attr}>{with_points(value)}</p>"


def details(summary: str, inner: str) -> str:
    return (
        '<details class="ansbox"><summary><span class="mtag ans">参考答案</span>'
        f"{esc(summary)}</summary>{inner}</details>"
    )


Q1_PARAGRAPHS = [
    "各地因地制宜，找准坐标、错位发展：【1分】",
    "一、科技创新赋能传统产业升级。【1分】研发前沿技术；联合高校打造研发中心，引进团队，建全链条研发体系。【1分】",
    "二、发展民营经济。【1分】出台政策，建立梯次化培育格局，【1分】营造良好环境，打造产业集群。【1分】",
    "三、发展电商经济。【1分】建产业园、“产业+电商”模式；【1分】建淘宝镇村、引育企业、开网店，带动群众就业创业。【1分】",
    "四、推动产业融合。【1分】规模种植、研发系列产品；培育龙头企业，延长产业链；【1分】打造影视城、沉浸式体验，推动影视旅游融合。【1分】",
    "五、发展港口经济。【1分】服务融入枢纽建设；招商、项目合资合作、搭建平台；【1分】整合资源，全力要素支持。【1分】",
]


Q2_PARAGRAPHS = [
    "法治要与时俱进、因地制宜才能发挥治理效能。【2分】",
    "1.出台新规，保障权益。【1分】针对新就业群体权益，地方立法，【1分】针对性、可操作性规划、明确职责；【1分】建立协同机制、设服务站点及数字化平台，织密关爱网。【1分】",
    "2.执法精简高效监管，赋能市场活力。【2分】针对重复检查，试点 AEO 制度，聚焦重点企业、大数据精准画像、【1分】“免申即享+告知承诺”方式分类差异化监管；【1分】动态调整机制。【1分】",
    "3.司法公正，为创新提供底气。【2分】针对恶意诉讼，构建多部门协同保护体系，【1分】行政+司法联动全维度护航。【1分】",
    "4.创新宣传载体，营造遵法守法氛围。【2分】创意情景剧、新媒体作品等，延伸文创产品，沉浸式、融入式、联动式创新活动，【1分】寓教于乐，融入群众日常。【1分】",
    "因此，要全面推进依法治国为现代化提供有力保障。【1分】",
]


Q3_PARAGRAPHS = [
    ("title", "关于J市创新“预付宝”监管模式的信息专报【1分】"),
    (
        "body",
        "预付式消费便捷也引发问题，为破解困局J市上线预付宝，入驻多领域1.8万余商家。【1分】本模式精准识别痛点设计制度，创新技术应用、升级治理理念，实现多赢局面。【2分】",
    ),
    ("heading", "一、平台赋能严格监管，消费者更放心。【2分】"),
    (
        "body",
        "1.操作简单：平台一站式完成；【1分】2.信托式监管。【1分】联合银行、信托、支付宝，预付款入监管账户，【1分】全过程服务，消费监控透明可追溯；【1分】商家可随时退款、消费者可查询专属账单。【1分】",
    ),
    ("heading", "二、信用+资金双重赋能，让商家更得利。【2分】"),
    (
        "body",
        "1.专属融资支持：账户资金免申即享优惠利率；【1分】一键申请低利率提款；【1分】申专属信用卡免息信用支付；【1分】2.市场化手段：【1分】补贴政策，授权标识牌，商家主动诚信经营。【1分】",
    ),
    ("heading", "三、完善治理体系，让市场更繁荣。【2分】"),
    (
        "body",
        "发布意见，推进立法，【1分】激活市场自净功能，形成良好生态。【1分】",
    ),
    (
        "body",
        "未来将在服务高质量发展中明确定位，科学有效发挥政府作用，扩大内需，擦亮“放心消费在J市”的名片。【2分】",
    ),
    ("html", '<p><b class="pt">结构分：1分</b></p>'),
]


Q4_TABLE_ROWS = [
    (
        "在城乡一体化中，找准县域经济坐标",
        "因地制宜、错位发展、串珠成链",
        "打开发展新局面",
    ),
    (
        "在四个全面中，找准依法治国坐标",
        "与时俱进、释法明理、柔性为民",
        "为发展提供新保障",
    ),
    (
        "在社会治理中，找准有为政府坐标",
        "瞄准问题，监管有力、优化服务",
        "打造共赢新格局",
    ),
    (
        "在产业/经济发展中，找准企业创新定位",
        "洞察趋势，聚焦需求，前瞻布局",
        "实现发展新跨越",
    ),
]


Q4_ESSAY = [
    (
        "",
        "“不谋全局者，不足以谋一域；不谋万世者，不足以谋一时。”十五五开局之年，是实现中华民族百年奋斗目标的新坐标。坐标明，方向定；方位准，步履稳。山东作为高质量发展的排头兵，始终牢记习近平总书记殷切嘱托“走在前，挑大梁”。未来的山东，更应以咬定青山不放松的韧劲，以系统化思维锚定坐标，串珠成链，以链带面，绘就中国式现代化的山东图景。",
    ),
    (
        "在城乡一体化中，找准县域经济坐标，因地制宜、错位发展、串珠成链，打开发展新局面。",
        "习近平总书记强调要“更好发挥县城连接城市、带动乡村作用”。县域是城乡融合的支点，也是强省建设的底盘。山东引导各县立足禀赋、错位竞争：广饶聚智攻关轮胎技术；曹县借电商激活汉服经济；乐陵深耕调味品，叫响“中国调料第一城”；乳山向海图强，崛起风电装备集群。一县一赛道、各美其美，分散的县域支点串珠成链，汇成全省高质量发展强劲增长带。",
    ),
    (
        "在四个全面中，找准依法治国坐标，与时俱进、释法明理、柔性为民，为发展提供新保障。",
        "“治世不一道，便国不必法古。”法与时转则治，治与世宜则有功。依法治国是战略布局中的有力保障。Y区新规护新业、信用减负担、司法护创新、普法润民心，刚柔并济；潍坊在全国率先预制菜专项政策、发布系列标准，为新兴业态立规赋能。提升法治水平，要科技赋能向前跑，更要明确法治为民的目标，以人性温度与执法力度，提升保障新高度。",
    ),
    (
        "在社会治理中，找准有为政府坐标，瞄准问题，监管有力、优化服务，打造共赢新格局。",
        "有为政府是风险“防火墙”、市场“护航员”、群众“贴心人”。社会治理中，政府是定盘星，是领航人。J市“预付宝”信托监管，让预付资金笔笔透明、商家主动诚信；山东首创“一次办好”，让群众“只进一扇门、最多跑一次”。山东政府担当责任，聚焦难点痛点，从粗放管理到精准服务，从单打独斗到协同监管，从“官老爷”到“店小二”，让监管有力，服务有心，群众开心、企业放心，实现多方共赢。",
    ),
    (
        "在产业/经济发展中，找准企业创新坐标，洞察趋势，聚焦需求，前瞻布局，实现发展新跨越。",
        "“察势者智，驭势者赢。”发展新质生产力是大势所趋，企业在新兴产业中找准定位就是找发展捷径。东虹科技预判卫星互联网浪潮，主攻大运力低成本火箭；海阳依港聚链，崛起东方航天港产业集群。若企业定位不清，或盲目跟风，或战略失误，最终只能是“跟随者”，甚至是“失败者”。企业的坐标，要根植于产业大势，落脚于真实需求，更要敏锐识别发展趋势，超前精准布局，找准赛道，方能弯道超车。",
    ),
    (
        "",
        "“开局决定全局，起步关乎后程。”十五五新征程上，山东将持续锚定坐标、协同发力，以一域之所能服务全局之所需，让高质量发展壮美画卷在齐鲁大地徐徐铺展，交出无愧时代、不负嘱托的中国式现代化山东“高分答卷”。",
    ),
]


def q4_structure() -> str:
    rows = "".join(
        "<tr>"
        + "".join(f"<td>{esc(cell)}</td>" for cell in row)
        + "</tr>"
        for row in Q4_TABLE_ROWS
    )
    body = (
        '<div class="bdtitle">由“主题”拆成四个坐标</div>'
        '<div class="tbwrap"><table><thead><tr>'
        "<th>在什么中找到什么坐标？</th>"
        "<th>如何发挥好这一坐标作用？</th>"
        "<th>达到什么效果？</th>"
        f"</tr></thead><tbody>{rows}</tbody></table></div>"
    )
    return answer_ref("写作结构", body)


def q4_titles() -> str:
    body = (
        "<p><b>标题一：</b>锚定坐标 书写山东现代化“高分答卷”</p>"
        "<p><b>标题二：</b>咬定青山不放松</p>"
        '<p class="fwsub">——锚定坐标 绘就中国式现代化山东新图景</p>'
    )
    return answer_ref("标题示例", body)


def q4_essay() -> str:
    paragraphs = []
    for lead, rest in Q4_ESSAY:
        if lead:
            paragraphs.append(
                f'<p><b class="rk">{esc(lead)}</b>{esc(rest)}</p>'
            )
        else:
            paragraphs.append(f"<p>{esc(rest)}</p>")
    body = (
        '<div class="fw">'
        '<p class="fwtitle">咬定青山不放松</p>'
        '<p class="fwsub">——锚定坐标 绘就中国式现代化山东新图景</p>'
        + "".join(paragraphs)
        + "</div>"
    )
    return answer_ref("参考范文", body)


def build_answers() -> dict[str, str]:
    q1 = answer_ref(
        "评分标准与参考答案",
        "".join(paragraph(item) for item in Q1_PARAGRAPHS),
    )
    q2 = answer_ref(
        "评分标准与参考答案",
        "".join(paragraph(item) for item in Q2_PARAGRAPHS),
    )

    q3_parts = []
    for kind, value in Q3_PARAGRAPHS:
        if kind == "title":
            q3_parts.append(paragraph(value, "sh"))
        elif kind == "heading":
            q3_parts.append(paragraph(value, "sh"))
        elif kind == "html":
            q3_parts.append(value)
        else:
            q3_parts.append(paragraph(value))
    q3 = answer_ref("评分标准与参考答案", "".join(q3_parts))

    q1_html = details("点击查看参考答案与评分标准", q1)
    q2_html = details("点击查看参考答案与评分标准", q2)
    q3_html = (
        details("点击查看参考答案与评分标准", q3)
        + '<div class="bannote">本题显性采分点合计 25 分；原册作“一键申专属信用卡”，'
        '“结构分：1分”单列于末尾，页面均按原卷照录。</div>'
    )
    q4_html = details(
        "点击查看写作结构、标题示例与参考范文",
        q4_structure() + q4_titles() + q4_essay(),
    ) + (
        '<div class="bannote">原册第四题以结构表、两个标题示例和一篇参考范文呈现，'
        "未逐项标注分值；页面不替原册补设采分分项。</div>"
    )
    return {"sq1": q1_html, "sq2": q2_html, "sq3": q3_html, "sq4": q4_html}


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, got {count}")
    return text.replace(old, new, 1)


def update_page() -> None:
    text = PAGE.read_text(encoding="utf-8")
    answers = build_answers()

    old_intro = (
        "2026年10月31日提升卷三申论题本，共9页：给定资料5则、作答要求4题。"
        "题本为纯图版，正文已逐页识别并核对；卷面手写批注、划线和旁批未录入正文。"
        "参考答案、评分标准与范文尚未随本批素材提供，页面保留待录入提示。"
    )
    new_intro = (
        "2026年山东申论B类模考（提升卷三）共9页：给定资料5则、作答要求4题，"
        "分值15／20／25／40，主题为“坐标”。题本已逐页识别并核对；3页参考答案"
        "已并入每题折叠区，前三题保留评分标准与参考表述，第四题保留写作结构表、"
        "两个标题示例与完整参考范文。卷面手写批注、划线和旁批未录入正文。"
    )
    text = replace_once(text, old_intro, new_intro, "page intro")

    old_meta = (
        "<span>题本 9 页</span><span>给定资料 5 则</span>"
        "<span>作答要求 4 题</span><span>总分 100</span><span>参考答案待录入</span>"
    )
    new_meta = (
        "<span>题本 9 页</span><span>材料 5 则</span><span>作答 4 题</span>"
        "<span>参考答案 3 页</span><span>第四题附结构表与范文</span>"
    )
    text = replace_once(text, old_meta, new_meta, "page meta")

    text = replace_once(
        text,
        '<span class="chip wait">参考答案与评分标准待录入</span>',
        '<button class="btn" id="hideans">展开全部答案</button>',
        "answer button",
    )
    text = replace_once(
        text,
        '<input id="q" placeholder="搜索材料或题目关键词，回车定位…">',
        '<input id="q" placeholder="搜索材料、题目、评分标准或范文关键词…">',
        "search placeholder",
    )
    text = replace_once(
        text,
        "本页为10月31日提升卷三申论题本正文；材料层次按卷面“资料1～资料5”保留。"
        "官方参考答案与评分标准尚未提供，因此不生成答案内容。",
        "本页材料按卷面“资料1～资料5”保留；参考答案与评分标准见下方各题折叠区。"
        "答案原文按下发PDF照录，未依据题干另行推测。",
        "material note",
    )

    start_marker = '<div class="module" id="timu">'
    end_marker = '<div class="foot-tip">'
    start = text.index(start_marker)
    end = text.index(end_marker, start)
    question_area = text[start:end]
    parts = re.split(r"(?=<div class=\"shen\" id=\"sq[1-4]\">)", question_area)
    if len(parts) != 5:
        raise RuntimeError(f"question cards: expected prefix + 4 cards, got {len(parts)}")

    replaced = [parts[0]]
    for part in parts[1:]:
        match = re.search(r'<div class="shen" id="(sq[1-4])">', part)
        if not match:
            raise RuntimeError("question card id not found")
        qid = match.group(1)
        placeholder = (
            '<div class="bannote">参考答案、评分标准与范文待官方材料入站后补录。</div>'
        )
        if part.count(placeholder) != 1:
            raise RuntimeError(f"{qid}: answer placeholder count is not 1")
        replaced.append(part.replace(placeholder, answers[qid], 1))

    text = text[:start] + "".join(replaced) + text[end:]
    PAGE.write_text(text, encoding="utf-8")


def js_literal(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def update_hub() -> None:
    text = HUB.read_text(encoding="utf-8")
    pattern = re.compile(r"^  \{ t:'10月31日模考'.*? \},\r?$", flags=re.MULTILINE)
    matches = pattern.findall(text)
    if len(matches) != 1:
        raise RuntimeError(f"hub 10月31 entry: expected 1, got {len(matches)}")

    desc = (
        "2026年10月31日提升卷三：行测题本29页、120题，政治理论10题、常识判断10题、"
        "言语理解与表达30题、数量关系10题、判断推理40题、资料分析20题；题干、选项与"
        "四组资料逐页文字化，图形推理第61～70题和资料分析表格、折线图、柱形图保留卷面原图。"
        "官方答案版25页的120题答案与解析已全部录入，数量关系与资料分析的分式、根号按页图"
        "重排为一行算式；官方解析接续页与题号边界已核对。申论题本9页、给定资料5则、"
        "作答要求4题已文字化，主题为“坐标”；3页参考答案已分题录入，前三题保留采分标准"
        "与参考表述，第四题保留写作结构表、两个标题示例与完整参考范文。本次作答记录与"
        "正式成绩尚未提供，相关页面保留待录入状态，不生成推测内容。"
    )
    entry = (
        "  { t:'10月31日模考', name:'提升卷三（10月31日模考）', no:'第 17 期', "
        "state:'行测120题 + 官方答案解析25页 + 申论9页题本与3页参考答案已录入 · "
        "错题 / 成绩待补', "
        f"desc:{js_literal(desc)}, "
        "qc:'120 题 · 官方答案解析 25 页 · 已全部录入', "
        "sc:'题本 9 页 · 材料 5 则 · 4 大题 · 参考答案 3 页', "
        "cc:'待作答清单', cj:'待正式成绩表' },"
    )
    text = pattern.sub(entry, text, count=1)
    HUB.write_text(text, encoding="utf-8")


def update_index() -> None:
    text = INDEX.read_text(encoding="utf-8")
    pattern = re.compile(r"^\{ id:'mk-261031'.*? \},\r?$", flags=re.MULTILINE)
    matches = pattern.findall(text)
    if len(matches) != 1:
        raise RuntimeError(f"index 10月31 entry: expected 1, got {len(matches)}")

    sub = (
        "行测120题 + 官方答案解析25页 · 申论9页题本 + 3页参考答案 · "
        "错题与成绩待补"
    )
    desc = (
        "2026年10月31日提升卷三：行测题本29页、120题，政治理论10题、常识判断10题、"
        "言语理解与表达30题、数量关系10题、判断推理40题、资料分析20题；题干、选项与"
        "四组资料逐页文字化，图形推理第61～70题和资料分析表格、折线图、柱形图保留卷面原图。"
        "官方答案版25页的120题答案与解析已全部录入，数量关系与资料分析的分式、根号按页图"
        "重排为一行算式；官方解析接续页与题号边界已核对。申论题本9页、给定资料5则、"
        "作答要求4题已文字化，主题为“坐标”；3页参考答案已分题录入，前三题保留采分标准"
        "与参考表述，第四题保留写作结构表、两个标题示例与完整参考范文。本次作答记录与"
        "正式成绩尚未提供，相关页面保留待录入状态，不生成推测内容。"
    )
    keywords = [
        "10月31日",
        "10月31日模考",
        "提升卷三",
        "提升卷三申论",
        "山东申论B类",
        "第十七期",
        "第17期",
        "模考",
        "行测",
        "申论",
        "120题",
        "120 题",
        "题本",
        "答案",
        "解析",
        "官方答案版",
        "参考答案",
        "评分标准",
        "采分点",
        "参考范文",
        "锚定坐标",
        "咬定青山不放松",
        "政治理论",
        "常识判断",
        "言语理解",
        "数量关系",
        "判断推理",
        "资料分析",
        "图形推理",
        "县域经济",
        "轮胎之都",
        "江北A股第一县",
        "电商强县",
        "金丝小枣",
        "影视城",
        "港口经济",
        "商业航天",
        "海卫一号",
        "东虹科技",
        "星多箭少",
        "法治H市",
        "预付宝",
        "坐标",
        "信息专报",
        "作答记录待补",
    ]
    keyword_js = ",".join(js_literal(item) for item in keywords)
    entry = (
        "{ id:'mk-261031', name:'提升卷三（10月31日模考）', en:'2026-10-31', "
        "file:'sections/每周模考.html', color:'#f43f5e', "
        f"sub:{js_literal(sub)}, cnt:'第 17 期', "
        f"desc:{js_literal(desc)}, hit:'10月31日模考', "
        f"keywords:[{keyword_js}] }},"
    )
    text = pattern.sub(entry, text, count=1)
    INDEX.write_text(text, encoding="utf-8")


def update_fixtures() -> None:
    payload = json.loads(FIXTURES.read_text(encoding="utf-8"))
    additions = [
        {
            "q": "咬定青山不放松",
            "expect": {"min": 1, "section": "mk-261031"},
            "why": "第 17 期申论参考答案 · 第四题标题示例与参考范文（答案批次）",
        },
        {
            "q": "锚定坐标 书写山东现代化",
            "expect": {"min": 1, "section": "mk-261031"},
            "why": "第 17 期申论参考答案 · 第四题标题示例（答案批次）",
        },
    ]
    existing = {item.get("q") for item in payload["queries"]}
    for item in additions:
        if item["q"] not in existing:
            payload["queries"].append(item)
            existing.add(item["q"])
    FIXTURES.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    update_page()
    update_hub()
    update_index()
    update_fixtures()
    print(f"updated {PAGE}")
    print(f"updated {HUB}")
    print(f"updated {INDEX}")
    print(f"updated {FIXTURES}")


if __name__ == "__main__":
    main()
