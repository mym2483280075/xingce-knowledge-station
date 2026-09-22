# -*- coding: utf-8 -*-
"""抗干扰下载器：绕开 hosts / 加速器，失败自动换链路，支持断点续传。

【为什么不用浏览器直接下】
  本机装了 Watt Toolkit 之类的加速器时，github.com / raw.githubusercontent.com /
  objects.githubusercontent.com 会被写进 hosts 指向 127.0.0.1，交给它的本地反代。
  实测这条路径对小请求更快（339ms -> 123ms），但大文件反而更慢（raw 92 -> 25 KB/s），
  而且一旦它的某一跳卡住，浏览器只会一直转圈，没有任何补救。

  本脚本用 netguard 拿真实 IP 直连，失败就换下一个 IP 重来，并靠 Range 断点续传，
  所以「网络抖一下」不会让整次下载从头再来。

用法：
  python scripts\\gfetch.py <url>
  python scripts\\gfetch.py <url> -o D:\\downloads\\x.zip
  python scripts\\gfetch.py <url> --tries 6 --timeout 60
"""

import argparse
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import netguard  # noqa: E402

# 下载常见域名：Release 的二进制在 objects.githubusercontent.com，
# 源码包在 codeload.github.com
EXTRA_HOSTS = (
    "codeload.github.com",
    "github-releases.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "raw.github.com",
)


def _human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def download(url, out=None, tries=5, timeout=60, quiet=False):
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    out = out or os.path.basename(parts.path) or "download.bin"
    part = out + ".part"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    done = os.path.getsize(part) if os.path.exists(part) else 0
    total = done if done else None
    last = None

    for attempt in range(1, tries + 1):
        headers = {"User-Agent": "xs-gfetch", "Cache-Control": "no-cache"}
        if done:
            headers["Range"] = f"bytes={done}-"
        req = urllib.request.Request(url, headers=headers)
        try:
            with opener.open(req, timeout=timeout) as resp:
                if done and resp.status == 200:
                    done = 0                     # 服务器不支持 Range，只能重来
                clen = resp.headers.get("Content-Length")
                if clen:
                    total = done + int(clen)
                elif total is None:
                    total = done
                mode = "ab" if done else "wb"
                started = time.time()
                with open(part, mode) as handle:
                    while True:
                        chunk = resp.read(262144)
                        if not chunk:
                            break
                        handle.write(chunk)
                        done += len(chunk)
                        if not quiet and total:
                            speed = done / 1024 / max(time.time() - started, 0.001)
                            sys.stderr.write(f"\r  {done/1048576:6.2f}/{total/1048576:.2f} MB"
                                             f"   {speed:7.1f} KB/s")
                            sys.stderr.flush()
            if not quiet:
                sys.stderr.write("\n")
            if total and done >= total:
                os.replace(part, out)
                return out, done, attempt
            last = f"只拿到 {done}/{total} 字节"
        except Exception as exc:
            if not quiet:
                sys.stderr.write("\n")
            last = f"{type(exc).__name__}: {exc}"
        netguard.rotate(host)                    # 换一条真实链路再试
        if attempt < tries:
            delay = min(2 ** (attempt - 1), 8)
            if not quiet:
                print(f"  ! 第 {attempt} 次失败（{last}），{delay}s 后从 {_human(done)} 处续传…")
            time.sleep(delay)

    raise RuntimeError(f"下载失败 {url} → {last}")


def main():
    ap = argparse.ArgumentParser(description="抗干扰下载器（绕开 hosts/加速器，自动重试续传）")
    ap.add_argument("url")
    ap.add_argument("-o", "--output", default="")
    ap.add_argument("--tries", type=int, default=5)
    ap.add_argument("--timeout", type=int, default=60)
    ap.add_argument("--no-netguard", action="store_true")
    ap.add_argument("--netguard-dns", default=",".join(netguard.DEFAULT_DNS))
    args = ap.parse_args()

    if not args.no_netguard:
        servers = tuple(s.strip() for s in args.netguard_dns.split(",") if s.strip())
        rows = netguard.install(extra=EXTRA_HOSTS, servers=servers or netguard.DEFAULT_DNS)
        host = urllib.parse.urlsplit(args.url).hostname or ""
        for name, ips, _system in rows:
            if name == host:
                print(f"  {name} -> {', '.join(ips[:3])}"
                      + ("   ← 系统解析已被接管，已绕过" if netguard.hijacked(name) else ""))

    started = time.time()
    path, size, attempt = download(args.url, out=args.output or None,
                                   tries=max(1, args.tries), timeout=max(5, args.timeout))
    elapsed = time.time() - started
    print(f"✓ {path}")
    print(f"  {size} 字节（{_human(size)}）  用时 {elapsed:.1f}s"
          f"  平均 {size/1024/max(elapsed,0.001):.1f} KB/s  重试 {attempt-1} 次")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已中断（.part 文件保留，重跑可续传）")
        sys.exit(130)
    except Exception as exc:
        print(f"\n✗ {type(exc).__name__}: {exc}")
        sys.exit(1)
