from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PERIOD = ROOT / "sections" / "每周模考" / "11月13日模考"
TEMPLATE = ROOT / "sections" / "每周模考" / "10月28日模考" / "成绩分析.html"
OUTPUT = PERIOD / "成绩分析.html"

WRONG = {
    "政治理论": "4、6、8、9、14、16",
    "常识判断": "24、25、30、31、34、35",
    "言语理解": "37、40、60、63",
    "数量关系": "66、67、68、70、71、72、74、75",
    "图形推理": "78、79、82；另有 1 道待定位",
    "定义判断": "94、95；另有 1 道待定位",
    "类比推理": "无",
    "逻辑判断": "107、108、109",
    "资料分析": "118、121、124、126、127、129、130",
}
LUCKY = {
    "政治理论": "5、7、10、12、19",
    "常识判断": "23、32、33",
    "言语理解": "无",
    "数量关系": "69、73",
    "图形推理": "83、84",
    "定义判断": "无",
    "类比推理": "无",
    "逻辑判断": "110",
    "资料分析": "113、119、128",
}
NEXT_TARGET = {
    "政治理论": 14,
    "常识判断": 9,
    "言语理解": 26,
    "数量关系": 3,
    "图形推理": 7,
    "定义判断": 8,
    "类比推理": 5,
    "逻辑判断": 8,
    "资料分析": 14,
}


def signed(value: float, digits: int = 1) -> str:
    if value > 0:
        return f"＋{value:.{digits}f}"
    if value < 0:
        return f"−{abs(value):.{digits}f}"
    return "0"


def tone(rate: float) -> str:
    if rate >= 80:
        return "ok"
    if rate < 50:
        return "bad"
    return "mid"


def delta_class(value: float) -> str:
    if value >= 0.5:
        return " d ok"
    if value <= -0.5:
        return " d bad"
    return " d"


def extract_head() -> str:
    text = TEMPLATE.read_text(encoding="utf-8")
    head = re.search(r"<head>(.*?)</head>", text, flags=re.S).group(1)
    head = re.sub(r"<title>.*?</title>", "<title>提升卷四（11月13日模考） · 成绩分析 · 公考工作站</title>", head, count=1)
    return head


def module_rows(modules: list[dict[str, object]]) -> str:
    rows = []
    for module in modules:
        rate = float(module["rate"])
        delta = float(module["delta_previous"])
        mark = tone(rate)
        rows.append(
            '<tr>'
            f'<td class="nm">{module["name"]}</td>'
            f'<td class="num">{float(module["maximum"]):.1f}</td>'
            f'<td class="num d{(" ok" if rate >= 80 else " bad" if rate < 50 else "")}">{float(module["score"]):.1f}</td>'
            f'<td><div class="bar {mark}"><i style="width:{rate}%"></i></div><span class="rate">{rate:.1f}%</span></td>'
            f'<td class="num">{module["class_mean"]:.2f}</td>'
            f'<td class="num{delta_class(float(module["delta_mean"]))}">{signed(float(module["delta_mean"]), 2)}</td>'
            f'<td class="num">{module["correct"]} / {module["questions"]}</td>'
            f'<td class="num">{module["class_rank"]} / {module["class_n"]}</td>'
            f'<td class="num{delta_class(delta)}">{signed(delta)}</td>'
            '</tr>'
        )
    return "".join(rows)


def comparison_rows(modules: list[dict[str, object]]) -> str:
    rows = []
    for module in modules:
        target_correct = NEXT_TARGET[str(module["name"])]
        step = float(module["maximum"]) / int(module["questions"])
        target_score = target_correct * step
        rows.append(
            "<tr>"
            f'<td class="nm">{module["name"]}</td>'
            f'<td class="num">{module["correct"]} / {module["questions"]}</td>'
            f'<td class="num">{float(module["score"]):.1f}</td>'
            f'<td class="num">{target_correct} / {module["questions"]}</td>'
            f'<td class="num d ok">{signed(target_score - float(module["score"]))}</td>'
            "</tr>"
        )
    return "".join(rows)


def shenlun_rows(items: list[dict[str, object]], analysis: dict[str, object]) -> str:
    rows = []
    for item in items:
        name = str(item["name"])
        rate = float(item["rate"])
        mark = tone(rate)
        labels = []
        if name == analysis["strongest_rate"]:
            labels.append("得分率最高")
        if name == analysis["weakest_rate"]:
            labels.append("得分率最低")
        if name == analysis["largest_loss"]:
            labels.append("失分最多")
        tag = " · ".join(labels) or "中段"
        tag_tone = (
            "ok"
            if name == analysis["strongest_rate"]
            else "bad"
            if name in {analysis["weakest_rate"], analysis["largest_loss"]}
            else "mid"
        )
        rows.append(
            "<tr>"
            f'<td class="num">第 {item["number"]} 题</td>'
            f'<td class="nm">{name}</td>'
            f'<td class="num">{float(item["maximum"]):.0f}</td>'
            f'<td class="num d{(" ok" if rate >= 70 else " bad" if rate < 60 else "")}">{float(item["score"]):.1f}</td>'
            f'<td><div class="bar {mark}"><i style="width:{rate}%"></i></div><span class="rate">{rate:.1f}%</span></td>'
            f'<td class="num">−{float(item["lost"]):.1f}</td>'
            f'<td><span class="tag {tag_tone}">{tag}</span></td>'
            "</tr>"
        )
    return "".join(rows)


def loss_rows(modules: list[dict[str, object]]) -> str:
    order = ["数量关系", "资料分析", "政治理论", "常识判断", "图形推理", "言语理解", "定义判断", "逻辑判断", "类比推理"]
    by_name = {str(module["name"]): module for module in modules}
    rows = []
    for index, name in enumerate(order, start=1):
        module = by_name[name]
        rows.append(
            '<div class="wrow">'
            f'<div class="wn">{index}. {name}<i>失 {float(module["lost"]):.1f} 分</i></div>'
            f'<div class="wd">正确 {module["correct"]} / {module["questions"]}，'
            f'得分率 {float(module["rate"]):.1f}%，较上一场 {signed(float(module["delta_previous"]))}，'
            f'班内 {module["class_rank"]} / {module["class_n"]}。</div>'
            '</div>'
        )
    return "".join(rows)


def detail_rows(modules: list[dict[str, object]]) -> str:
    rows = []
    for module in modules:
        name = str(module["name"])
        rows.append(
            '<div class="wrow">'
            f'<div class="wn">{name}<i>{float(module["score"]):.1f} / {float(module["maximum"]):.1f}</i></div>'
            f'<div class="wd"><b>错题：</b>{WRONG[name]}<br><b>蒙对：</b>{LUCKY[name]}</div>'
            '</div>'
        )
    return "".join(rows)


def build(analysis_path: Path) -> str:
    analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
    target = analysis["target"]
    total = analysis["total"]
    shenlun = analysis["shenlun"]
    shenlun_items = analysis["shenlun_items"]
    xingce = analysis["xingce"]
    modules = analysis["modules"]
    correct_total = sum(int(module["correct"]) for module in modules)
    wrong_total = 130 - correct_total
    lucky_total = 17
    stable_total = correct_total - lucky_total

    head = extract_head()
    body = f"""
<body>
<header>
  <h1>提升卷四（11月13日模考） · 成绩分析</h1>
  <div class="intro">本页以正式成绩表为分数与排名依据，并用错题 / 蒙对清单与申论五题分项做题型复盘。行测九模块合计 67.7，申论五题合计 62.5，综合 130.2；所有层级均完成勾稽。</div>
  <div class="meta"><span>行测 67.7 / 100</span><span>申论 62.5 / 100</span><span>综合 130.2 / 200</span><span>总分年级 325</span><span>行测年级 276</span></div>
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
  <h2>一句话结论 <em>正式成绩口径</em></h2>
  <p class="lead">本次正式成绩为 <b>行测 67.7 / 100、申论 62.5 / 100、综合 130.2 / 200</b>。与 10月28日相比，行测 <b>回升 3.8 分</b>，申论 <b>回落 9.0 分</b>，所以总分下降 <b>5.2 分</b>。行测已经高于班均 0.42 分；综合仍低于班中位 3.4 分，主要拖累从行测切换到了申论。</p>
  <div class="kpis">
    <div class="kpi"><div class="k">行测</div><div class="v">67.7<small>/ 100</small></div><div class="n">班内 {target["xingce_class_rank"]} / {target["xingce_class_n"]} · 年级 276 · 高于班均 ＋0.42</div></div>
    <div class="kpi warn"><div class="k">申论</div><div class="v">62.5<small>/ 100</small></div><div class="n">班内 {target["shenlun_class_rank"]} / {target["shenlun_class_n"]} · 年级 407 · 低于班均 −2.86</div></div>
    <div class="kpi warn"><div class="k">综合</div><div class="v">130.2<small>/ 200</small></div><div class="n">班内 {target["total_class_rank"]} / {target["total_class_n"]} · 年级 325 · 班中位 133.6</div></div>
    <div class="kpi warn"><div class="k">作答稳定性</div><div class="v">{wrong_total}<small>错</small></div><div class="n">另有 17 题蒙对 · 稳固正确 {stable_total} 题 · 2 道未定位</div></div>
  </div>
</section>

<section class="scard" id="cj-zhenduan">
  <h2>四条诊断 <em>先看结构，再定补分顺序</em></h2>
  <div class="diag">
    <div class="ditem two"><b>① 总分回落不是全科退步：行测 ＋3.8，申论 −9.0</b><p>申论五题为概括 5 / 10、分析 10 / 15、公文 12 / 20、对策 14.5 / 20、大作文 21 / 35。小题合计 41.5 / 65（63.8%），大作文 21 / 35（60%）；行测已回到班均之上，下一场的关键仍是申论止跌。</p></div>
    <div class="ditem good"><b>② 行测最明确的进步在言语：13.3 → 18.2，单模块 ＋4.9</b><p>言语正确 26 / 30，得分率 86.7%，班内第 12 / 85，高于班均 2.03；政治 11.2 / 16（＋1.6）、常识 5.4 / 9（＋0.6）、类比 4 / 4（＋0.8）也同步走强。说明上阶段对言语与基础判断的处理开始转为可兑现的分。</p></div>
    <div class="ditem two"><b>③ 当前最弱是数量 20%，其次图形 60%、资料 65%</b><p>数量只对 2 / 10，仍是最低比例项；图形从 70% 回落到 60%，班内第 66 / 85；资料从 70% 回落到 65%，班内第 58 / 85。三项合计丢 16.3 分，是行测继续向上最直接的容量。</p></div>
    <div class="ditem"><b>④ 正式分为 67.7，但作答清单只能解释 69.2</b><p>正式九模块反推出 89 道正确、41 道错误；清单明确列出 39 道错题和 17 道蒙对，差口集中在图形与定义各少列 1 道错题。故按“明确错题 / 蒙对 / 待定位”三档处理，不猜题号。</p></div>
  </div>
</section>

<section class="scard" id="cj-weizhi">
  <h2>位置分布 <em>当前在班里的真实坐标</em></h2>
  <div class="tblwrap"><table class="mod">
    <thead><tr><th>指标</th><th>本人</th><th>班内名次</th><th>班均</th><th>中位</th><th>P25</th><th>P75</th><th>判断</th></tr></thead>
    <tbody>
      <tr class="big"><td class="nm">行测</td><td class="num d">{target["xingce"]:.1f}</td><td class="num">{target["xingce_class_rank"]} / {target["xingce_class_n"]}</td><td class="num">{xingce["mean"]:.2f}</td><td class="num">{xingce["median"]:.2f}</td><td class="num">{xingce["p25"]:.2f}</td><td class="num">{xingce["p75"]:.2f}</td><td><span class="tag mid">中位附近</span></td></tr>
      <tr><td class="nm">申论</td><td class="num d bad">{target["shenlun"]:.1f}</td><td class="num">{target["shenlun_class_rank"]} / {target["shenlun_class_n"]}</td><td class="num">{shenlun["mean"]:.2f}</td><td class="num">{shenlun["median"]:.2f}</td><td class="num">{shenlun["p25"]:.2f}</td><td class="num">{shenlun["p75"]:.2f}</td><td><span class="tag bad">贴 P25</span></td></tr>
      <tr><td class="nm">综合</td><td class="num d bad">{target["total"]:.1f}</td><td class="num">{target["total_class_rank"]} / {target["total_class_n"]}</td><td class="num">{total["mean"]:.2f}</td><td class="num">{total["median"]:.2f}</td><td class="num">{total["p25"]:.2f}</td><td class="num">{total["p75"]:.2f}</td><td><span class="tag bad">中游偏下</span></td></tr>
    </tbody>
  </table></div>
  <p class="tnote">口径：班内名次按 308 班有效样本重算；综合只统计行测、申论均有效的 {target["complete_n"]} 人。年级名次直接取正式成绩表。本人综合 130.2 高于班 P25 4.35 分，但低于班均 1.85、中位 3.4、P75 10.2；当前目标应先回到中位，而不是直接追 P75。</p>
</section>

<section class="scard" id="cj-modules">
  <h2>九模块明细 <em>正式配分 + 班内对照 + 上期变化</em></h2>
  <p class="pintro">正式满分：政治 16、常识 9、言语 21、数量 9、图形 7、定义 8、类比 4、逻辑 8、资料 18，合计 100；“较上期”对照 10月28日同人分数。</p>
  <div class="tblwrap"><table class="mod">
    <thead><tr><th>模块</th><th>满分</th><th>得分</th><th>得分率</th><th>班均</th><th>较班均</th><th>正确题数</th><th>班内</th><th>较上期</th></tr></thead>
    <tbody>{module_rows(modules)}</tbody>
  </table></div>
  <p class="tnote">校验：九模块相加 = 67.7；正确题数相加 = {correct_total} / 130，对应 {wrong_total} 道错题。17 道蒙对虽计入正式得分，但不计入“稳固正确”；本场稳固正确为 {stable_total} 题。</p>
</section>

<section class="scard" id="cj-shenlun-items">
  <h2>申论五题分项 <em>正式得分与题型强弱</em></h2>
  <p class="pintro">五项满分分别为 10、15、20、20、35，合计 100；得分合计 62.5，与正式申论总分一致。得分率只用于同一场内部比较，不等同于官方题型难度评价。</p>
  <div class="tblwrap"><table class="mod">
    <thead><tr><th>题号</th><th>题型</th><th>满分</th><th>得分</th><th>得分率</th><th>失分</th><th>定位</th></tr></thead>
    <tbody>{shenlun_rows(shenlun_items["items"], shenlun_items)}</tbody>
  </table></div>
  <div class="diag">
    <div class="ditem two"><b>① 最弱项是概括题：5 / 10，得分率 50%</b><p>概括题只拿到一半，说明本场“找全要点并压成动宾短语”比议论文成文更薄弱。复盘时先按材料段落逐段列点，再核对参考答案是否漏主体、漏手段、漏效果；不要先追求句子漂亮。</p></div>
    <div class="ditem two"><b>② 大作文绝对失分最大：21 / 35，丢 14 分</b><p>得分率只有 60%，单题失分占全卷 37.5 分的 37.3%。优先检查立意是否准确、三个分论点是否都从材料来、每一段是否有“论点—论据—分析—回扣”；字体卷面和字数不是第一顺位。</p></div>
    <div class="ditem"><b>③ 公文与分析均为中段：60% 与 66.7%</b><p>工作简报 12 / 20，分析题 10 / 15。公文先守住标题、主体分条、语言规范和字数；分析题按“是什么—为什么—怎么办”检查结构，重点看是否把材料中的多层含义合并或漏项。</p></div>
    <div class="ditem good"><b>④ 对策题是当前最强项：14.5 / 20（72.5%）</b><p>题内排名第一，说明“问题—建议一一对应、动作具体”的框架已经能稳定拿分。继续维持问题分类与对策主体、做法、目的三要素，不必把下一阶段大量时间放在对策题重建上。</p></div>
  </div>
  <p class="tnote">下一阶段建议只设三个可验证动作：概括题目标 7 / 10（＋2），工作简报目标 13 / 20（＋1），大作文目标 23 / 35（＋2）；分析和对策先维持，五项合计目标约 67.5。</p>
</section>

<section class="scard" id="cj-shibai">
  <h2>失分去向 <em>按绝对失分排序</em></h2>
  <p class="pintro">下表用于看失分容量，不等同于提分优先级。数量关系绝对失分最高，但多数题超出稳定可解范围；资料与图推的题型更集中、单题分也更高，下一阶段应先做。</p>
  {loss_rows(modules)}
</section>

<section class="scard" id="cj-cuoti">
  <h2>错题与蒙对清单 <em>与正式成绩交叉核对</em></h2>
  <p class="pintro">下列题号可进入 <a href="行测错题集合.html">行测错题集合</a>逐题查看。“蒙对”是答案正确但作答时不确定，处理顺序应与错题相同。</p>
  <div class="bannote">正式模块分显示图形、定义各有 1 道已错但未进入清单；当前只标为“待定位”，不凭分数反推题号。</div>
  {detail_rows(modules)}
</section>

<section class="scard" id="cj-bufen">
  <h2>补分路径 <em>下一场先拿 4 分左右可复制分</em></h2>
  <div class="tblwrap"><table class="mod">
    <thead><tr><th>模块</th><th>本场正确</th><th>本场得分</th><th>下一场题数</th><th>目标净增</th></tr></thead>
    <tbody>{comparison_rows(modules)}</tbody>
  </table></div>
  <ol class="plan">
    <li><b>第一优先：资料分析做“七题重算”。</b>118、121、124、126、127、129、130 覆盖基期量、比重、平均数、乘积增长率与综合分析。每题只写“找数 → 列式 → 估算 → 选项”四行，先拿回 1～2 题。</li>
    <li><b>第二优先：数量关系固定挑题。</b>只从比例、基础排列、几何面积、年龄方程四类中挑会做的 3 题。目标是 3 / 10，不追求十题全做。</li>
    <li><b>第三优先：图形与定义各回收 1 题。</b>图形先查位置、样式、数量、属性四个规律层级；定义只抓主体、对象、行为、条件、结果五个要素。回看未列清单里各 1 道待定位错题，补全真实错题记录。</li>
    <li><b>守住已有强项：言语、政治、常识、类比。</b>本场分别较上期 ＋4.9、＋1.6、＋0.6、＋0.8，不做大规模重建，只用隔天回刷维持手感。</li>
    <li><b>申论按分项补，不再只看总分。</b>概括题先补到 7 / 10，大作文补到 23 / 35，工作简报补到 13 / 20；三项合计先回收 5 分，就能把申论从 62.5 拉回 67.5 左右。行测已过班均，不应继续挤占申论恢复时间。</li>
  </ol>
  <div class="goal"><b>下一场目标：</b>行测 71～72、申论 67～68、综合 138～140。这个目标只需行测净增 4 分左右，并由申论恢复约一半的上场回撤，不要求所有模块同时刷新高点。</div>
</section>

<section class="scard" id="cj-shuoming">
  <h2>数据口径与质量 <em>看结论前先读</em></h2>
  <ul class="note">
    <li><b>成绩来源：</b>用户提供的 11月13日正式成绩表截图；按固定网格识别本人整行，并校验九模块合计 67.7、行测＋申论合计 130.2。原始表本地留存、未入站，页面不含姓名与准考证号。</li>
    <li><b>作答来源：</b>站内清单含 56 条标记答案：39 道明确做错、17 道蒙对。按正式模块分反推应共有 41 道错题，差口在图推、定义各 1 道；这两个题号暂不猜测。</li>
    <li><b>排名与班均：</b>班内名次按 308 班有效样本重算：行测 85 人、申论 90 人、两科齐全 79 人；年级名次直接取正式成绩表。缺考与科目空白不计入相应均值。</li>
    <li><b>跨期口径：</b>两场均为 130 题、九模块同配分，行测模块分与总分可直接比较；申论只比较 100 分制总分。上期基线为行测 63.9、申论 71.5、综合 135.4。</li>
    <li><b>申论分项：</b>五题得分由用户提供并与正式总分闭合：5＋10＋12＋14.5＋21＝62.5；满分按卷面 10＋15＋20＋20＋35＝100。未提供逐题答卷与批改细项，因此只分析题型得分结构，不推断具体扣分点。</li>
    <li><b>缺失信息：</b>截图未提供逐题用时与作答顺序，因此不判断速度或涂卡顺序。</li>
  </ul>
</section>
</main>
<button class="backtop" id="bt" title="回到顶部">↑</button>
<script src="../../../assets/%E6%9D%BF%E5%9D%97%E9%A1%B5%E8%84%9A%E6%9C%AC.js?v=0cbebb75"></script>
<script>(function(){{var b=document.getElementById('bt');function f(){{if(b)b.classList.toggle('show',window.scrollY>500)}}window.addEventListener('scroll',f,{{passive:true}});if(b)b.addEventListener('click',function(){{window.scrollTo({{top:0,behavior:'smooth'}})}});}})();</script>
</body>
</html>
"""
    return f'<!DOCTYPE html>\n<html lang="zh-CN" data-theme="mock">\n<head>{head}</head>\n{body}'


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("analysis", type=Path)
    args = parser.parse_args()
    text = build(args.analysis)
    OUTPUT.write_text(text, encoding="utf-8")
    print(f"built={OUTPUT} bytes={len(text.encode('utf-8'))}")


if __name__ == "__main__":
    main()
