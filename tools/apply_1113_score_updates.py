from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if text.count(old) != 1:
        raise ValueError(f"{label}: expected one match, got {text.count(old)}")
    return text.replace(old, new, 1)


def update_hub() -> None:
    path = ROOT / "sections" / "每周模考.html"
    text = path.read_text(encoding="utf-8")
    pattern = r"(?m)^  \{ t:'11月13日模考'.*? \},\r?$"
    item = (
        "  { t:'11月13日模考', name:'提升卷四（11月13日模考）', no:'第 18 期', "
        "state:'行测130题 + 官方答案解析27页 + 39道明确错题 + 17道蒙对（六大板块合并） + "
        "申论10页题本与4页参考答案 + 正式成绩分析已录入 · 2题待定位', "
        "desc:'2026年11月13日第18期：行测提升卷四，30页、130题，政治理论20题、常识判断15题、"
        "言语理解与表达30题、数量关系10题、判断推理35题、资料分析20题；题干、选项与四组资料已文字化，"
        "图形推理76～85题、第74题坐标图选项、第111题饼图及三组资料图表保留卷面原图。"
        "官方答案版27页的130题答案与解析已全部录入，算式已按页图重排。申论为强化卷三（四川卷），"
        "题本10页、材料5则、作答5题，参考答案4页已分题录入，第三题保留两份工作简报，第五题保留完整范文。"
        "正式成绩为行测67.7、申论62.5、综合130.2，总分年级325、班内49/79；行测较上场提高3.8分，"
        "申论回落9.0分。申论五题为概括5/10、分析10/15、公文12/20、对策14.5/20、大作文21/35；"
        "概括得分率最低，对策最高，大作文失分最多。作答清单列出39道明确错题和17道蒙对，正式模块分反推共41道错题，"
        "图推、定义各差1道未定位，相关页面已明确标注而不猜题号。', "
        "qc:'130题 · 官方答案解析27页 · 已全部录入', "
        "sc:'题本10页 · 材料5则 · 5大题 · 参考答案4页', "
        "cc:'39 道明确错题 + 17 道蒙对 · 2 题待定位', "
        "cj:'正式成绩 行测67.7 + 申论62.5 = 130.2 · 综合年级325 · 班内49/79' },"
    )
    text, count = re.subn(pattern, lambda _: item, text, count=1)
    if count != 1:
        raise ValueError("模考中心 11月13日 条目未唯一匹配")
    path.write_text(text, encoding="utf-8")


def update_index() -> None:
    path = ROOT / "index.html"
    text = path.read_text(encoding="utf-8")
    pattern = r"(?m)^\{ id:'mk-261113'.*? \},\r?$"
    item = (
        "{ id:'mk-261113', name:'提升卷四（11月13日模考）', en:'2026-11-13', "
        "file:'sections/每周模考.html', color:'#f43f5e', "
        "sub:'行测130题 + 39道明确错题 + 17道蒙对 · 申论题本与参考答案 · 正式成绩130.2 · 2题待定位', "
        "cnt:'第 18 期', "
        "desc:'2026年11月13日第18期：行测提升卷四130题、官方答案解析27页，申论强化卷三（四川卷）"
        "题本10页、材料5则、作答5题、参考答案4页均已录入。正式成绩为行测67.7、申论62.5、"
        "综合130.2，总分年级325、班内49/79；行测较上场提高3.8分，申论回落9.0分。"
        "申论五题：概括5/10、分析10/15、公文12/20、对策14.5/20、大作文21/35。"
        "作答清单明确39道错题与17道蒙对，正式模块分反推共41道错题，图推与定义各1道待定位。', "
        "hit:'11月13日模考', "
        "keywords:['11月13日','11月13日模考','提升卷四','提升卷四申论','强化卷三','四川卷',"
        "'第十八期','第18期','模考','行测','申论','130题','题本','答案','解析','官方答案版',"
        "'参考答案','评分标准','参考范文','政治理论','常识判断','言语理解','数量关系','判断推理',"
        "'资料分析','图形推理','食安小站','沙盒监管','益·峨眉','社区矫正','12315','苜蓿干草',"
        "'法理情理为经纬','申论五题分项','概括题5分','对策题14.5分','大作文21分',"
        "'39道明确错题','17道蒙对','2题待定位','错题集合','蒙对题',"
        "'正式成绩130.2','行测67.7','申论62.5','班内49/79'] },"
    )
    text, count = re.subn(pattern, lambda _: item, text, count=1)
    if count != 1:
        raise ValueError("首页 11月13日 条目未唯一匹配")
    path.write_text(text, encoding="utf-8")


def update_review_page() -> None:
    path = ROOT / "sections" / "每周模考" / "11月13日模考" / "行测错题集合.html"
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        '<div class="intro">本次作答清单共56道：做错39道，不确定但选对17道。二者统一按六大板块合并，每题仍标注“做错”或“蒙对题”；正式成绩、用时和每题耗时尚未提供，不据此推算总分或排名。</div>',
        '<div class="intro">本次作答清单共56道：明确做错39道、不确定但选对17道。正式成绩反推应有41道错题，差口在图形、定义各1道；当前只标“待定位”，不猜题号。二者仍统一按六大板块合并，每题保留“做错/蒙对题”标记。</div>',
        "错题集合 intro",
    )
    text = replace_once(
        text,
        '<div class="meta"><span>56条作答</span><span>39道错题</span><span>17道蒙对</span><span>六大板块合并</span><span>正式成绩待补</span></div>',
        '<div class="meta"><span>56条标记</span><span>39道明确错题</span><span>17道蒙对</span><span>正式反推41道错题</span><span>2道待定位</span></div>',
        "错题集合 meta",
    )
    text = replace_once(
        text,
        '<div class="bannote">清单口径：39道做错、17道蒙对；二者按六大板块合并，不另建“蒙对题”分区。蒙对题虽然答案正确，仍应遮住答案重做，确认不是排除法和选项分布带来的偶然命中。错因与复习记录暂留空，不替用户编造。</div>',
        '<div class="bannote">正式成绩：行测67.7、申论62.5、综合130.2。清单明确39道错题、17道蒙对；正式模块分反推应共有41道错题，差口在图推和定义各1道。两者按六大板块合并，不另建“蒙对题”分区；未定位的2题不计入现有卡片，也不凭分数反猜题号。</div>',
        "错题集合 bannote",
    )
    path.write_text(text, encoding="utf-8")


def update_search_fixtures() -> None:
    path = ROOT / "scripts" / "search-fixtures.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    additions = [
        ("正式成绩 130.2", "第18期正式综合成绩"),
        ("行测 67.7", "第18期正式行测成绩"),
        ("申论 62.5", "第18期正式申论成绩"),
        ("班内 49 / 79", "第18期两科齐全样本的班内位置"),
        ("作答清单只能解释 69.2", "第18期正式成绩与作答清单差异"),
        ("2 道未定位", "第18期图形、定义各差1道错题"),
        ("申论五题分项", "第18期申论五题得分结构"),
        ("概括题 5 / 10", "第18期申论概括题得分"),
        ("大作文 21 / 35", "第18期申论大作文得分"),
    ]
    existing = {query.get("q") for query in payload["queries"]}
    for query, why in additions:
        if query not in existing:
            payload["queries"].append(
                {
                    "q": query,
                    "expect": {"min": 1, "section": "mk-261113"},
                    "why": why,
                }
            )
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    update_hub()
    update_index()
    update_review_page()
    update_search_fixtures()
    print("updated hub, index, review metadata, and search fixtures")


if __name__ == "__main__":
    main()
