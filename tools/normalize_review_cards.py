#!/usr/bin/env python3
"""按题卡标题中的板块名归位，并恢复各板块题号顺序。"""
from __future__ import annotations

import re
from pathlib import Path

from bs4 import BeautifulSoup, Tag

ROOT = Path(__file__).resolve().parent.parent
SLUGS = {
    "政治理论": "zz",
    "常识判断": "cs",
    "言语理解与表达": "yy",
    "言语理解": "yy",
    "数量关系": "sl",
    "判断推理": "pd",
    "资料分析": "zl",
}


def question_number(card: Tag) -> int:
    match = re.search(r"q(\d+)$", card.get("id", ""))
    if not match:
        raise ValueError(f"无法解析题号：{card.get('id')}")
    return int(match.group(1))


def section_slug(card: Tag) -> str:
    head = card.select_one(".qhead")
    text = head.get_text(" ", strip=True) if head else ""
    name = text.split("·", 1)[0].strip()
    if name not in SLUGS:
        raise ValueError(f"无法从题卡标题识别板块：{text!r}")
    return SLUGS[name]


def sort_cards(body: Tag) -> None:
    cards = body.find_all("div", class_="qcard", recursive=False)
    for card in sorted(cards, key=question_number):
        number = question_number(card)
        for existing in body.find_all("div", class_="qcard", recursive=False):
            if existing is not card and question_number(existing) > number:
                card.extract()
                existing.insert_before(card)
                break


def position_materials(body: Tag) -> None:
    for material in body.find_all("div", class_="matcard", recursive=False):
        match = re.search(r"mat-(\d+)(?:-\d+)?$", material.get("id", ""))
        if not match:
            continue
        start = int(match.group(1))
        for card in body.find_all("div", class_="qcard", recursive=False):
            if question_number(card) >= start:
                material.extract()
                card.insert_before(material)
                break


def update_counts(soup: BeautifulSoup) -> None:
    for module in soup.select("div.module[id^=cat-]"):
        body = module.find("div", class_="mod-body", recursive=False)
        if not body:
            continue
        count = len(body.find_all("div", class_="qcard", recursive=False))
        number = module.select_one(".mod-banner .num")
        if number and count:
            number.string = f"{count} 道题"
        link = soup.find("a", href=f"#{module.get('id')}")
        if link and count:
            count_node = link.find("i")
            if count_node:
                count_node.string = f"{count} 题"


def normalize(path: Path) -> int:
    soup = BeautifulSoup(path.read_text(encoding="utf-8"), "html.parser")
    moved = 0
    for card in list(soup.select("div.qcard[id^=cat-]")):
        slug = section_slug(card)
        target = soup.find("div", id=f"cat-{slug}")
        if not target:
            raise ValueError(f"{path}: 缺少目标模块 cat-{slug}")
        if card.find_parent("div", class_="module", id=f"cat-{slug}"):
            continue
        number = question_number(card)
        card["id"] = f"cat-{slug}-q{number}"
        body = target.find("div", class_="mod-body", recursive=False)
        for existing in body.find_all("div", class_="qcard", recursive=False):
            if question_number(existing) > number:
                card.extract()
                existing.insert_before(card)
                break
        else:
            card.extract()
            body.append(card)
        moved += 1

    for module in soup.select("div.module[id^=cat-]"):
        body = module.find("div", class_="mod-body", recursive=False)
        if body:
            sort_cards(body)
            position_materials(body)
    update_counts(soup)
    path.write_text(str(soup), encoding="utf-8")
    return moved


def main() -> None:
    total = 0
    for path in sorted((ROOT / "sections" / "每周模考").rglob("行测错题集合.html")):
        moved = normalize(path)
        if moved:
            print(f"{path.relative_to(ROOT)}: moved={moved}")
        total += moved
    print(f"moved={total}")


if __name__ == "__main__":
    main()
