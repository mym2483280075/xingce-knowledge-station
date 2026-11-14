#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全站静态质量门：结构、引用、锚点、id、图片与错题合流规则。

用法：
  python scripts/check-site.py
  python scripts/check-site.py --quiet

这个脚本只做确定性问题，不替代人工内容审校。HTML 结构使用标准库
HTMLParser 检查不会隐式闭合的关键容器；外部严格审计仍可另跑 html-validate。
"""
from __future__ import annotations

import argparse
import io
import re
import sys
import urllib.parse
from html.parser import HTMLParser
from pathlib import Path

try:
    sys.stdout = io.TextIOWrapper(
        sys.stdout.buffer, encoding="utf-8", errors="replace",
        line_buffering=True, write_through=True,
    )
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", "__pycache__", "node_modules", ".idea", ".vscode"}
TRACKED_TAGS = {
    "html",
    "head",
    "body",
    "main",
    "header",
    "footer",
    "div",
    "section",
    "details",
    "summary",
    "span",
}


def walk_html() -> list[Path]:
    files: list[Path] = []
    for path in ROOT.rglob("*.html"):
        if any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
            continue
        files.append(path)
    return sorted(files)


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, int]] = []
        self.errors: list[str] = []
        self.ids: set[str] = set()
        self.duplicate_ids: set[str] = set()
        self.refs: list[tuple[str, int]] = []
        self.images: list[dict[str, object]] = []
        self.has_bqd = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        data = {key.lower(): value or "" for key, value in attrs}
        line = self.getpos()[0]
        if tag in TRACKED_TAGS:
            self.stack.append((tag, line))
        if data.get("id"):
            if data["id"] in self.ids:
                self.duplicate_ids.add(data["id"])
            self.ids.add(data["id"])
        if data.get("id") == "cat-bqd":
            self.has_bqd = True
        for attr in ("href", "src", "poster"):
            if data.get(attr):
                self.refs.append((data[attr], line))
        if tag == "img":
            self.images.append({"attrs": data, "line": line})

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        if tag not in TRACKED_TAGS:
            return
        line = self.getpos()[0]
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                if index != len(self.stack) - 1:
                    open_tags = ", ".join(item[0] for item in self.stack[index + 1 :])
                    self.errors.append(f"第 {line} 行关闭 </{tag}> 时仍有未闭合元素：{open_tags}")
                del self.stack[index:]
                return
        self.errors.append(f"第 {line} 行出现没有对应开始标签的 </{tag}>")

    def finish(self) -> None:
        for tag, line in self.stack:
            self.errors.append(f"第 {line} 行 <{tag}> 到文档结束仍未闭合")
        self.stack.clear()


def resolve_ref(page: Path, raw: str) -> tuple[Path, str] | None:
    value = raw.strip()
    if not value or value.startswith(("http:", "https:", "mailto:", "tel:", "data:", "javascript:")):
        return None
    parsed = urllib.parse.urlsplit(value)
    path_text = urllib.parse.unquote(parsed.path)
    target = page if not path_text else (page.parent / path_text).resolve()
    return target, urllib.parse.unquote(parsed.fragment)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    files = walk_html()
    pages: dict[Path, PageParser] = {}
    errors: list[str] = []
    warnings: list[str] = []
    refs: list[tuple[Path, Path, str, int]] = []

    for path in files:
        parser = PageParser()
        try:
            parser.feed(path.read_text(encoding="utf-8", errors="replace"))
            parser.finish()
        except Exception as exc:
            errors.append(f"{path.relative_to(ROOT)}: 解析失败：{exc}")
            continue
        pages[path] = parser
        rel = path.relative_to(ROOT).as_posix()
        for message in parser.errors:
            errors.append(f"{rel}: {message}")
        for ident in sorted(parser.duplicate_ids):
            errors.append(f"{rel}: 重复 id：{ident}")
        if parser.has_bqd:
            errors.append(f"{rel}: 错题与蒙对题不得拆成 cat-bqd，应合并到六大板块")
        for raw, line in parser.refs:
            resolved = resolve_ref(path, raw)
            if resolved:
                target, fragment = resolved
                refs.append((path, target, fragment, line))

    anchors = {path: parser.ids for path, parser in pages.items()}
    for page, target, fragment, line in refs:
        rel = page.relative_to(ROOT).as_posix()
        if not target.exists():
            shown = target.relative_to(ROOT) if target.is_relative_to(ROOT) else target
            errors.append(f"{rel}:{line}: 引用不存在：{shown}")
            continue
        if fragment and target.suffix.lower() in {".html", ".htm"} and target in anchors:
            if fragment not in anchors[target]:
                errors.append(f"{rel}:{line}: 锚点不存在：{target.relative_to(ROOT).as_posix()}#{fragment}")

    image_count = 0
    for page, parser in pages.items():
        rel = page.relative_to(ROOT).as_posix()
        for image in parser.images:
            image_count += 1
            attrs: dict[str, str] = image["attrs"]  # type: ignore[assignment]
            line = int(image["line"])
            src = attrs.get("src", "")
            if not src:
                errors.append(f"{rel}:{line}: <img> 缺少 src")
                continue
            path_text = urllib.parse.unquote(urllib.parse.urlsplit(src).path)
            if Path(path_text).suffix.lower() != ".webp":
                errors.append(f"{rel}:{line}: 最终图片引用不是 WebP：{src}")
            if "alt" not in attrs:
                errors.append(f"{rel}:{line}: <img> 缺少 alt")
            if attrs.get("loading") != "lazy":
                errors.append(f"{rel}:{line}: <img> 缺少 loading=\"lazy\"")
            if not attrs.get("width") or not attrs.get("height"):
                warnings.append(f"{rel}:{line}: <img> 缺少 width/height，可能产生布局跳动")
            if "题图文件名" in src:
                errors.append(f"{rel}:{line}: 仍引用模板占位图：{src}")

    css_urls = 0
    for css in ROOT.rglob("*.css"):
        if any(part in SKIP_DIRS for part in css.relative_to(ROOT).parts):
            continue
        text = css.read_text(encoding="utf-8", errors="replace")
        for match in re.finditer(r"url\(\s*['\"]?([^'\")?#]+)", text, re.I):
            raw = match.group(1).strip()
            if raw.startswith(("data:", "http:", "https:")):
                continue
            css_urls += 1
            target = (css.parent / urllib.parse.unquote(raw)).resolve()
            if not target.exists():
                errors.append(f"{css.relative_to(ROOT).as_posix()}: CSS 引用不存在：{raw}")

    if not args.quiet:
        print(f"① HTML 结构  {len(files)} 页")
        print(f"② 引用与锚点  {len(refs)} 条链接，{css_urls} 条 CSS URL")
        print(f"③ id 唯一性  {sum(len(p.ids) for p in pages.values())} 个 id")
        print(f"④ 图片规范  {image_count} 个 <img>")
        print("⑤ 错题合流  0 个 cat-bqd" if not any(p.has_bqd for p in pages.values()) else "⑤ 错题合流  发现 cat-bqd")
        for warning in warnings[:12]:
            print("   ⚠ " + warning)
        if len(warnings) > 12:
            print(f"   ⚠ 另有 {len(warnings) - 12} 条警告")

    if errors:
        print("")
        for message in errors[:40]:
            print("   ✗ " + message)
        if len(errors) > 40:
            print(f"   ✗ 另有 {len(errors) - 40} 个错误")
        print(f"\n全站质量门未通过：{len(errors)} 个错误 / {len(warnings)} 个警告")
        return 1

    print(
        f"\n全站质量门通过：{len(files)} 页、{len(refs)} 条链接、"
        f"{sum(len(p.ids) for p in pages.values())} 个 id、{image_count} 张图片"
        + (f"，{len(warnings)} 个警告" if warnings else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
