# -*- coding: utf-8 -*-
"""
公考工作站 · 位图转 WebP（引用驱动）

为什么按「引用」转，而不是按目录转：
  sections/ 下躺着大量历史遗留图片（换过版式的整卷扫描、被错题集合取代的题图），
  页面一张都不引用它们。按目录全量转会把这些也转一遍、白传一遍流量，页面一分钱不省。
  所以本脚本只认「HTML 里真正 src/href/url() 引用到的那批」。

编码策略（2026-09-22 实测）：
  · PNG  → 无损 WebP：像素完全一致，省约 45%。
           板块页里大量是公式 / 表格 / 电路图截图，有损会把细线与文字边缘糊掉
           （实测同一批 PNG 用 q=92 有图 PSNR 掉到 27 dB，肉眼可见毛边）。
  · JPEG → 有损 WebP q=90：实测 PSNR 均值 43.6 dB、最小 36.2 dB，肉眼无差别，省约 34%。
           （q=85 起 PSNR 均值掉到 39 dB 档，省得也不多，不划算。）
  · 一张图若 q=90 的 PSNR 掉到 38 dB 以下（实测「公文格式·占格规范」那几条细长条会），
    自动改用 q=95；连 35 dB 都够不着的（细线稿重编码天生吃亏），直接保留原图 ——
    宁可大一点，也不让页面上的细线糊掉。
  · 转完反而更大的，原地保留原格式（不硬换），报告里单列。
  · 分辨率不动：输出宽高必须与原图完全相等，不等直接报错退出。
  · 无损图额外解码回来逐像素比对；有损图算 PSNR，低于 35 dB 报警。

用法：
  python scripts\to-webp.py                 # 只体检 + 预估，不写任何文件
  python scripts\to-webp.py --apply         # 转换 + 改写 HTML 里的引用
  python scripts\to-webp.py --apply --delete-originals    # 转换后再删掉原图
  python scripts\to-webp.py --check         # 只查引用：有没有 404 / 有没有漏转
  python scripts\to-webp.py --apply --redo  # 改了策略后，把已有 WebP 按新策略重编一遍
                                            # （原始 jpg/png 还在才重编，删过原图就自动跳过）

约定：
  · 只改 HTML 里引用的扩展名，URL 的其它部分（目录、中文文件名、?查询、#锚点、
    百分号编码形式）原样保留，所以中文路径不会因为重写而变成另一串编码。
  · 页面上引用的图片一律走 <img src>，没有 CSS 背景图与 srcset，所以不必处理媒体查询。
"""
import argparse
import io
import os
import re
import sys
import urllib.parse

from PIL import Image

# 和 publish.py 同一个理由：Windows 控制台默认 GBK，中文与 ✓/✗ 直接抛 UnicodeEncodeError。
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace",
                                  line_buffering=True, write_through=True)
except Exception:
    pass

try:
    import numpy as np
except ImportError:  # PSNR 检查是加分项，缺 numpy 也能跑
    np = None

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("XS_LOCAL") or os.path.dirname(HERE)
SKIP_DIRS = {".git", "__pycache__", "node_modules"}
TO_CONVERT = {".png", ".jpg", ".jpeg"}
SKIP_PREFIX = ("~$",)
PSNR_WARN = 35.0
PSNR_GOOD = 38.0

# 属性写法：src="…" / src='…' / url(…)；只认双引号太少，这个站两种都出现过
REF = re.compile(
    r"""(?P<attr>src|href|data-src|data-original)\s*=\s*(?P<q>["'])(?P<url>[^"']+?)(?P=q)"""
    r"""|url\(\s*["']?(?P<css>[^"')]+?)["']?\s*\)""",
    re.I,
)


def rel(p):
    return os.path.relpath(p, ROOT)


def html_files():
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = [d for d in dn if d not in SKIP_DIRS]
        for f in fn:
            if f.lower().endswith((".html", ".htm")):
                yield os.path.join(dp, f)


def read_text(p):
    return open(p, encoding="utf-8", errors="replace").read()


def references():
    """{图片绝对路径: [(页面绝对路径, 原始URL), …]}"""
    out = {}
    for page in html_files():
        for m in REF.finditer(read_text(page)):
            raw = m.group("url") or m.group("css") or ""
            if raw.lower().startswith(("http:", "https:", "data:", "#", "javascript:", "mailto:")):
                continue
            path = raw.split("?")[0].split("#")[0]
            if os.path.splitext(path)[1].lower() not in TO_CONVERT | {".webp", ".gif", ".svg", ".bmp"}:
                continue
            ap = os.path.normpath(os.path.join(os.path.dirname(page), urllib.parse.unquote(path)))
            out.setdefault(ap, []).append((page, raw))
    return out


def candidates(src_path):
    """按「先省、再保真」排列的编码候选：PNG 只有无损一档，JPEG 是 q90 → q95 → 无损。"""
    if os.path.splitext(src_path)[1].lower() == ".png":
        return [("lossless", {"lossless": True, "method": 6})]
    return [("q90", {"quality": 90, "method": 6}),
            ("q95", {"quality": 95, "method": 6}),
            ("lossless", {"lossless": True, "method": 6})]


def psnr(a, b):
    if np is None:
        return None
    x, y = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    mse = ((x - y) ** 2).mean()
    return None if mse == 0 else 10 * np.log10(255.0 ** 2 / mse)


def encode_best(src):
    """挑一个「比原图小、又够清楚」的编码。

    返回 (webp字节 或 None, 原大小, 新大小, psnr 或 None, 档位, 说明)
    —— None 表示候选都不合适，调用方应保留原图。
    """
    size0 = os.path.getsize(src)
    notes = []
    fallback = None  # 够用但不算好的：留着，万无一失比硬塞一张糊图强
    with Image.open(src) as im:
        im.load()
        wh = (im.width, im.height)
        ref = im.convert("RGBA")  # 统一到 RGBA 再比：调色板 / 灰度 / 带 alpha 都落在同一套通道上
        for label, kw in candidates(src):
            buf = io.BytesIO()
            im.save(buf, "WEBP", **kw)
            size1 = buf.tell()
            buf.seek(0)
            with Image.open(buf) as back:
                if (back.width, back.height) != wh:
                    raise RuntimeError("分辨率不一致：%dx%d → %dx%d"
                                       % (wh[0], wh[1], back.width, back.height))
                dec = back.convert("RGBA")
                if kw.get("lossless"):
                    if ref.tobytes() != dec.tobytes():
                        raise RuntimeError("无损 WebP 像素与原始 PNG 不一致")
                    v = 99.0  # 无损：像素一致，按满分记账
                else:
                    v = psnr(ref, dec)
            if size1 >= size0:
                notes.append("%s 反而更大（%d→%d）" % (label, size0, size1))
                continue
            if v is None or v >= PSNR_GOOD:
                return buf.getvalue(), size0, size1, v, label, "；".join(notes)
            if v >= PSNR_WARN:
                # 够看，但不如理想 —— 记下来，继续试更高档位
                fallback = (buf.getvalue(), size0, size1, v, label, "；".join(notes))
                notes.append("%s 只 %.2f dB，继续提档" % (label, v))
                continue
            notes.append("%s 只 %.2f dB，提档重编" % (label, v))
    if fallback:
        return fallback
    return None, size0, size0, None, "-", "；".join(notes) or "无可用档位"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真的写盘（缺省只报告）")
    ap.add_argument("--check", action="store_true", help="只查引用完整性与转换覆盖")
    ap.add_argument("--delete-originals", action="store_true", help="转换成功后删掉原图")
    ap.add_argument("--redo", action="store_true", help="把已有 WebP 按当前策略重编一遍（原图还在才重编）")
    args = ap.parse_args()

    refs = references()
    existing, missing, already = [], [], []
    for path, uses in refs.items():
        if not os.path.isfile(path):
            missing.append((path, uses))
        elif os.path.splitext(path)[1].lower() == ".webp":
            already.append(path)
        else:
            existing.append(path)

    print("站点根目录 : %s" % ROOT)
    print("引用图片   : %d 张（%d 个页面引用）" % (len(refs), len({u[0] for v in refs.values() for u in v})))
    print("  已是 WebP: %d" % len(already))
    print("  待转换   : %d（%.2f MB）" % (len(existing), sum(os.path.getsize(p) for p in existing) / 1048576))
    print("  引用不到 : %d" % len(missing))
    for path, uses in missing:
        print("    ✗ %s  ← %s" % (rel(path), rel(uses[0][0])))
        print("      （若是模板示例文本，忽略即可）")

    if args.check:
        return 1 if missing else 0

    todos = list(existing)
    redone = []
    if args.redo:
        # 已有 WebP 且原图还躺在旁边 —— 换了策略（比如把 q90 提到 q95）想重编一遍就用它
        for dp, dn, fn in os.walk(ROOT):
            dn[:] = [d for d in dn if d not in SKIP_DIRS]
            for f in fn:
                if not f.lower().endswith(".webp") or f.startswith(SKIP_PREFIX):
                    continue
                stem = os.path.join(dp, os.path.splitext(f)[0])
                for ext in TO_CONVERT:
                    if os.path.isfile(stem + ext):
                        redone.append(stem + ext)
                        break
        todos = sorted(set(todos) | set(redone))
        print("  重编     : %d（已是 WebP 且原图还在）" % len(redone))

    if not todos:
        print("\n✓ 已经没有需要转换的位图了。")
        return 0

    mapping, skipped, failed, psnrs, levels = {}, [], [], [], {}
    before = after = 0
    for i, src in enumerate(todos, 1):
        try:
            data, size0, size1, v, label, why = encode_best(src)
            if data is None:
                skipped.append((src, size0, size1, why))
                continue
            if args.apply:
                with open(os.path.splitext(src)[0] + ".webp", "wb") as f:
                    f.write(data)
            mapping[src] = os.path.splitext(src)[0] + ".webp"
            before += size0
            after += size1
            levels[label] = levels.get(label, 0) + 1
            if v is not None and v < 90:
                psnrs.append((v, rel(src)))
            if i % 50 == 0:
                print("  …已处理 %d/%d" % (i, len(todos)))
        except Exception as e:  # 坏图 / 编码器拒绝，一律跳过并记录，不中断整批
            failed.append((src, str(e)))

    print("\n转换结果：%d 张成功（%s），%d 张保留原格式，%d 张失败" %
          (len(mapping), "、".join("%s×%d" % (k, v) for k, v in sorted(levels.items())),
           len(skipped), len(failed)))
    if mapping:
        print("  体积：%.2f MB → %.2f MB（省 %.1f%%）" % (before / 1048576, after / 1048576,
                                                        100 * (1 - after / before)))
    if psnrs:
        psnrs.sort()
        print("  有损图 PSNR：最低 %.2f dB（%s），均值 %.2f dB" %
              (psnrs[0][0], psnrs[0][1], sum(v for v, _ in psnrs) / len(psnrs)))
        for v, name in psnrs:
            if v < PSNR_WARN:
                print("    ⚠ 低于 %.0f dB：%s（%.2f dB）" % (PSNR_WARN, name, v))
    for src, s0, s1, why in skipped[:10]:
        print("  · 保留原格式：%s（%s）" % (rel(src), why))
    for src, err in failed:
        print("  ✗ 失败：%s（%s）" % (rel(src), err))

    if not args.apply:
        print("\n（这是预估。真要写入请加 --apply）")
        return 0

    # ---- 改写引用：只换扩展名，URL 其余部分原样保留 ----
    touched = 0
    for page in html_files():
        text = read_text(page)
        counter = [0]

        def sub(m):
            raw = m.group("url") or m.group("css") or ""
            path = raw.split("?")[0].split("#")[0]
            if os.path.splitext(path)[1].lower() not in TO_CONVERT:
                return m.group(0)
            ap = os.path.normpath(os.path.join(os.path.dirname(page), urllib.parse.unquote(path)))
            dst = mapping.get(ap)
            if not dst:
                return m.group(0)
            new_url = raw[: len(path) - len(os.path.splitext(path)[1])] + ".webp" + raw[len(path):]
            counter[0] += 1
            if m.group("css") is not None:
                return "url(%s)" % new_url
            return "%s=%s%s%s" % (m.group("attr"), m.group("q"), new_url, m.group("q"))

        new_text = REF.sub(sub, text)
        if counter[0]:
            with open(page, "w", encoding="utf-8", newline="") as f:
                f.write(new_text)
            touched += counter[0]
            print("  改写 %s（%d 处）" % (rel(page), counter[0]))
    print("引用改写完成：%d 处" % touched)

    if args.delete_originals:
        removed = 0
        for src in mapping:
            os.remove(src)
            removed += 1
        print("已删除原图：%d 个（git 历史与线上仓库仍有旧版本，可随时找回）" % removed)

    print("\n下一步：python scripts\\build-index.js 不需要跑（索引只收正文文字，与图片无关）；"
          "发布用 publish.cmd --allow-delete，否则线上旧图不会被清掉。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
