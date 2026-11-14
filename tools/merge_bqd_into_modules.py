#!/usr/bin/env python3
"""一次性迁移：把旧版单独归档的蒙对题并入六大板块。"""
from __future__ import annotations

import re
from pathlib import Path

from bs4 import BeautifulSoup, Tag

ROOT = Path(__file__).resolve().parent.parent
MODULES = {
    "政治理论": "zz",
    "常识判断": "cs",
    "言语理解与表达": "yy",
    "数量关系": "sl",
    "判断推理": "pd",
    "资料分析": "zl",
}


def number_of(card: Tag) -> int:
    match = re.search(r"q(\d+)$", card.get("id", ""))
    if not match:
        raise ValueError(f"无法解析卡片题号：{card.get('id')}")
    return int(match.group(1))


def material_group(card: Tag) -> tuple[int, int] | None:
    match = re.search(r"mat-(\d+)(?:-(\d+))?$", card.get("id", ""))
    if not match:
        return None
    start = int(match.group(1))
    return start, int(match.group(2) or start)


def location_for_question(number: int) -> tuple[str, tuple[int, int]] | None:
    for start, end, slug in (
        (1, 20, "zz"),
        (21, 35, "cs"),
        (36, 65, "yy"),
        (66, 75, "sl"),
        (76, 110, "pd"),
        (111, 130, "zl"),
    ):
        if start <= number <= end:
            return slug, (start, end)
    return None


def insert_sorted(body: Tag, card: Tag, extra: list[Tag]) -> None:
    number = number_of(card)
    for existing in body.find_all("div", class_="qcard", recursive=False):
        if number_of(existing) > number:
            for node in extra:
                existing.insert_before(node)
            card.extract()
            existing.insert_before(card)
            return
    for node in extra:
        body.append(node)
    card.extract()
    body.append(card)


def update_counts(module: Tag) -> None:
    body = module.find("div", class_="mod-body", recursive=False)
    count = len(body.find_all("div", class_="qcard", recursive=False))
    number = module.select_one(".mod-banner .num")
    if number:
        number.string = f"{count} 道题"
    link = module.find_previous("a", href=f"#{module.get('id')}")
    if link:
        count_node = link.find("i")
        if count_node:
            count_node.string = f"{count} 题"


def migrate(path: Path) -> bool:
    html = path.read_text(encoding="utf-8")
    if 'id="cat-bqd"' not in html:
        return False
    soup = BeautifulSoup(html, "html.parser")
    bqd = soup.find("div", id="cat-bqd")
    if not bqd:
        return False
    bqd_body = bqd.find("div", class_="mod-body", recursive=False)
    modules: dict[str, Tag] = {}
    for name, slug in MODULES.items():
        module = soup.find("div", id=f"cat-{slug}")
        if not module:
            raise ValueError(f"{path}: 缺少目标模块 cat-{slug}")
        modules[slug] = module

    pending_materials: list[Tag] = []
    for child in list(bqd_body.find_all(recursive=False)):
        if "matcard" in (child.get("class") or []):
            pending_materials.append(child.extract())
            continue
        if "qcard" not in (child.get("class") or []):
            continue
        number = number_of(child)
        location = location_for_question(number)
        if not location:
            raise ValueError(f"{path}: 题号超出六大板块范围：{number}")
        slug, group = location
        target = modules[slug]
        target_body = target.find("div", class_="mod-body", recursive=False)
        existing_groups = {
            material_group(node)
            for node in target_body.find_all("div", class_="matcard", recursive=False)
        }
        extra: list[Tag] = []
        if group and group not in existing_groups:
            for material in pending_materials:
                if material_group(material) == group:
                    moved = material.extract()
                    moved["id"] = f"mat-{group[0]}-{group[1]}"
                    extra.append(moved)
                    break
        pending_materials = []
        child["id"] = f"cat-{slug}-q{number}"
        insert_sorted(target_body, child.extract(), extra)

    bqd.extract()
    toc_link = soup.find("a", href="#cat-bqd")
    if toc_link:
        toc_link.extract()
    for module in modules.values():
        update_counts(module)

    intro = soup.select_one("header .intro")
    if intro:
        text = intro.get_text(" ", strip=True)
        text = text.replace("错题按六大板块分置，蒙对题单列", "错题与蒙对题合并按六大板块分置")
        text = text.replace("错题按六大板块分置", "错题与蒙对题合并按六大板块分置")
        intro.string = text
    note = soup.select_one("main .bannote")
    if note:
        text = note.get_text(" ", strip=True)
        text = text.replace("“蒙对题”虽然答案正确，仍应遮住答案重做", "蒙对题虽然答案正确，仍应遮住答案重做")
        text = text.replace("错因与复习记录暂留空", "错题与蒙对题统一按板块复盘；错因与复习记录暂留空")
        note.string = text
    search = soup.find("input", id="q")
    if search:
        search["placeholder"] = "搜索错题或蒙对题题号、题干或考点…"

    path.write_text(str(soup), encoding="utf-8")
    return True


def main() -> None:
    changed = []
    for path in sorted((ROOT / "sections" / "每周模考").rglob("行测错题集合.html")):
        if migrate(path):
            changed.append(path)
    print(f"merged={len(changed)}")
    for path in changed:
        print(path.relative_to(ROOT))


if __name__ == "__main__":
    main()
