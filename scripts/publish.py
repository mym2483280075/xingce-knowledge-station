# -*- coding: utf-8 -*-
"""
公考工作站 · 一键发布到 GitHub Pages

为什么不用 git push：
  本机 github.com:443 不通（api.github.com 可达），git clone/push 会 connection reset。
  所以这里走 GitHub REST 的 Git Data API：建 blob → 建 tree（base_tree 保留其余文件）→ 建 commit → 更新 main。

一条命令的流程：
  1) 比对差异：把本地每个文件算成 git blob 哈希（自动忽略 CRLF/LF 差异），与线上 main 的 tree 比对
  2) 只提交真正变化的文件（其余文件不动，线上已有的内容不会被覆盖）
  3) 等 GitHub Pages 构建完成（校验构建对应的就是本次提交）
  4) 验证线上：把改动的文件从站点 URL 抓回来，逐字节比对哈希

用法：
  python scripts\\publish.py                 # 比对 → 发布 → 等构建 → 验证
  python scripts\\publish.py --check         # 只看差异，不发布
  python scripts\\publish.py -m "自定义提交信息"
  python scripts\\publish.py --allow-delete  # 允许把线上多余的文件删掉（默认只报告不删）
  python scripts\\publish.py --timeout 480   # 构建/验证的单步超时秒数（默认 300）
  python scripts\\publish.py --no-netguard   # 关闭抗干扰层（默认开启，见 netguard.py）
  python scripts\\publish.py --tries 6       # 单个 API 调用的重试次数（默认 4）

网络抗干扰（默认开启）：
  本机装了 Watt Toolkit 之类的加速器时，它们会往 hosts 里写
  「api.github.com -> 127.0.0.1」。实测这种接管对小请求反而更快，但对 295KB 的
  tree 响应必然 40s 超时，发布直接失败。所以本脚本默认用自建 DNS 解析真实 IP，
  完全绕开 hosts，并在重试时轮换 IP，详见 scripts\\netguard.py。
"""
import sys, io, os, re, json, time, socket, base64, hashlib, argparse, urllib.parse
import urllib.request, urllib.error

# ---------- 输出与配置 ----------
# 【易错 · 2026-09-20 排查结论】必须带 line_buffering=True。
# 这里把 sys.stdout 换成新的 TextIOWrapper，是为了在 Windows 上强制 UTF-8 输出；
# 但新建的 TextIOWrapper 默认是 8KB 块缓冲，而且**不受 -u / PYTHONUNBUFFERED 影响**
# ——那个开关只作用于解释器启动时的原始 stdout。结果：整个发布过程一句都不打印，
# 一直到进程退出才一次性倒出来，看起来就像卡死（实测：全部输出集中在退出的那一刻，
# 61.62s / 61.67s）。改成逐行刷新后，进度就是实时的。
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace",
                                  line_buffering=True, write_through=True)
except Exception:
    pass

TOKEN = (os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
         or os.environ.get("GITHUB_MCP_PAT") or "")
REPO = os.environ.get("XS_REPO", "mym2483280075/xingce-knowledge-station")
BRANCH = os.environ.get("XS_BRANCH", "main")
HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL = os.environ.get("XS_LOCAL", os.path.dirname(HERE))

TEXT_EXT = {".html", ".htm", ".css", ".js", ".mjs", ".json", ".md", ".txt", ".svg",
            ".xml", ".yml", ".yaml", ".csv", ".map", ".ts", ".jsx", ".tsx", ".py"}
VERIFY_EXT = TEXT_EXT | {".cmd", ".bat", ".ps1", ".sh"}
SKIP_DIRS = {".git", "__pycache__", "node_modules", ".idea", ".vscode"}
# 备份/临时文件不进仓库：这类文件一旦落到站点目录里，会被当成「新增文件」发到线上
SKIP_FILE_SUFFIX = (".bak", ".orig", ".tmp", ".swp", "~", ".save.bak")
SKIP_FILE_PREFIX = ("~$",)
SITE = f"https://{REPO.split('/')[0]}.github.io/{REPO.split('/')[1]}/"

API = "https://api.github.com"

# ---------- 网络抗干扰 ----------
# netguard 用自建 DNS 直接解析真实 IP，绕开 hosts / 加速器 / IPv6 黑洞，
# 并在重试时轮换 IP；详见 scripts\netguard.py。
sys.path.insert(0, HERE)
import netguard  # noqa: E402

# ---------- HTTP ----------
# tries      单个请求最多尝试几次
# api_timeout 单次尝试的超时（不是总时长）——半开连接要尽快放弃、换条链路
# deadline    单个请求的总时限，避免「重试次数 × 长超时」把一次发布拖成十分钟
NET = {"tries": 6, "api_timeout": 25, "deadline": 120}
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _open(req, timeout):
    """统一出口：显式不带任何环境代理。

    本机历史上出现过「失效的代理变量拖垮 api.github.com 直连」的问题，
    所以这里无视 HTTPS_PROXY/HTTP_PROXY。真要挂代理请显式改这里。
    """
    return _OPENER.open(req, timeout=timeout)


def api(method, path, body=None, retries=None, timeout=None, deadline=None):
    """GitHub REST 调用。

    【超时与重试的来历】本机到 GitHub 抖动极大：同一条链路能 10.6s 拿完 295KB，
    也能 87s 一个字节都不回（半开）。所以策略是「单次短超时 + 总时限内反复换链路」：
      · 单次 timeout=25s，半开连接最多浪费 25s 就换；
      · 每次重试 rotate() 换下一个候选 IP（候选表里含系统解析给的地址）；
      · 整个调用有 deadline=120s 兜底，不会因为重试次数把一次发布拖成十分钟。
    大 body 的调用（blob 上传）单独放宽。
    """
    retries = NET["tries"] if retries is None else retries
    timeout = NET["api_timeout"] if timeout is None else timeout
    deadline = NET["deadline"] if deadline is None else deadline
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={"Authorization": "Bearer " + TOKEN, "User-Agent": "xs-publish",
                 "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json; charset=utf-8"})
    last = None
    started = time.time()
    for i in range(retries):
        left = deadline - (time.time() - started)
        if left <= 1:
            last = f"{last}（已达总时限 {deadline}s）"
            break
        try:
            with _open(req, timeout=max(5.0, min(timeout, left))) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:400]
            last = f"HTTP {e.code}: {detail}"
            if e.code in (401, 403, 404, 409, 422):
                break
        except Exception as e:
            last = f"{type(e).__name__}: {e}"
        netguard.rotate("api.github.com")       # 下次重试换一条真实链路
        if i + 1 < retries:
            time.sleep(min(2 ** i, 8, max(0, deadline - (time.time() - started))))
    raise RuntimeError(f"{method} {path} 失败（尝试 {retries} 次，耗时 {time.time() - started:.0f}s）→ {last}")


def fetch(url, timeout=None, tries=None, deadline=None):
    """取回正文。失败一律换链路重试（原来 tries=1，一次卡死就整条流水线失败）。"""
    tries = NET["tries"] if tries is None else tries
    timeout = NET["api_timeout"] if timeout is None else timeout
    deadline = NET["deadline"] if deadline is None else deadline
    host = urllib.parse.urlsplit(url).hostname or ""
    last = None
    started = time.time()
    for i in range(tries):
        left = deadline - (time.time() - started)
        if left <= 1:
            break
        req = urllib.request.Request(url, headers={"User-Agent": "xs-publish", "Cache-Control": "no-cache"})
        try:
            with _open(req, timeout=max(5.0, min(timeout, left))) as r:
                return r.read()
        except Exception as e:
            last = e
        netguard.rotate(host)
        if i + 1 < tries:
            time.sleep(min(2 ** i, 8, max(0, deadline - (time.time() - started))))
    raise RuntimeError(f"抓取失败 {url}（尝试 {tries} 次 / {time.time() - started:.0f}s）→ {type(last).__name__}: {last}")


def head_len(url, timeout=25, tries=None, deadline=60):
    """只取 Content-Length，不下载正文。用于大文件的廉价校验：GitHub Pages 的 HEAD 会带精确字节数。"""
    tries = NET["tries"] if tries is None else tries
    host = urllib.parse.urlsplit(url).hostname or ""
    last = None
    started = time.time()
    for i in range(tries):
        left = deadline - (time.time() - started)
        if left <= 1:
            break
        try:
            req = urllib.request.Request(
                url + "?__cb=" + str(int(time.time() * 1000)),
                headers={"User-Agent": "xs-publish", "Cache-Control": "no-cache"}, method="HEAD")
            with _open(req, timeout=max(5.0, min(timeout, left))) as r:
                return r.headers.get("Content-Length")
        except Exception as e:
            last = e
        netguard.rotate(host)
        if i + 1 < tries:
            time.sleep(min(2 ** i, 8, max(0, deadline - (time.time() - started))))
    raise RuntimeError(f"HEAD 失败 {url}（尝试 {tries} 次 / {time.time() - started:.0f}s）→ {type(last).__name__}: {last}")


# ---------- 哈希 ----------
def blob_sha(data: bytes) -> str:
    h = hashlib.sha1()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


def _skip_file(name: str) -> bool:
    """备份/临时文件不参与发布。

    实例：改脚本时留下的 publish.py.bak-20260920-netguard 本来会被当成
    「新增文件」推到线上，污染仓库。
    """
    if name.startswith(SKIP_FILE_PREFIX):
        return True
    lower = name.lower()
    return lower.endswith(SKIP_FILE_SUFFIX) or ".bak-" in lower


def local_files():
    out = {}
    for root, dirs, files in os.walk(LOCAL):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if _skip_file(f):
                continue
            p = os.path.join(root, f)
            rel = os.path.relpath(p, LOCAL).replace("\\", "/")
            out[rel] = p
    return out


def payload_bytes(path, rel, remote_exists_lf: bool):
    """决定推给仓库的字节：文本文件统一存 LF，避免 CRLF 造成整文件假差异"""
    with open(path, "rb") as f:
        raw = f.read()
    lf = raw.replace(b"\r\n", b"\n")
    if raw == lf:
        return raw
    ext = os.path.splitext(rel)[1].lower()
    if remote_exists_lf or ext in TEXT_EXT:
        return lf
    return raw


def diff():
    ref = api("GET", f"/repos/{REPO}/git/refs/heads/{BRANCH}")
    head = ref["object"]["sha"]
    commit = api("GET", f"/repos/{REPO}/git/commits/{head}")
    tree_sha = commit["tree"]["sha"]
    # 295KB 的 tree 响应是全流程最容易卡住的一步（实测走加速器时 2/2 超时），
    # 所以单独放宽：单次 45s，总时限 240s，期间可以换好几条链路。
    tree = api("GET", f"/repos/{REPO}/git/trees/{tree_sha}?recursive=1",
               timeout=45, deadline=240)
    if tree.get("truncated"):
        print("  ! 线上 tree 被截断，改为逐个比对可能不准")
    remote = {e["path"]: e["sha"] for e in tree["tree"] if e["type"] == "blob"}

    changed, added, crlf_only, too_big = [], [], [], []
    for rel, path in sorted(local_files().items()):
        size = os.path.getsize(path)
        if size > 90 * 1024 * 1024:
            too_big.append((rel, size))
            continue
        with open(path, "rb") as f:
            raw = f.read()
        lf = raw.replace(b"\r\n", b"\n")
        s_raw, s_lf = blob_sha(raw), blob_sha(lf)
        rst = remote.get(rel)
        if rst is None:
            added.append((rel, size))
        elif rst == s_raw:
            pass
        elif rst == s_lf:
            crlf_only.append(rel)
        else:
            changed.append((rel, size))
    deleted = sorted(set(remote) - set(local_files()))
    return head, tree_sha, remote, changed, added, crlf_only, deleted, too_big


# ---------- 主流程 ----------
def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--check", action="store_true", help="只比对差异，不发布")
    ap.add_argument("-m", "--message", default="", help="自定义提交信息")
    ap.add_argument("--allow-delete", action="store_true", help="允许删除线上多出来的文件")
    ap.add_argument("--timeout", type=int, default=300, help="等构建/验证的超时秒数")
    ap.add_argument("--verify-full", action="store_true",
                    help="所有文件都逐字节校验（默认大索引只比 Content-Length）")
    ap.add_argument("--tries", type=int, default=6, help="单个请求最多尝试次数（默认 6）")
    ap.add_argument("--api-timeout", type=int, default=25,
                    help="单次尝试的超时秒数（默认 25，半开连接尽快放弃换链路）")
    ap.add_argument("--api-deadline", type=int, default=120, help="单个请求的总时限秒数（默认 120）")
    ap.add_argument("--no-netguard", action="store_true",
                    help="关闭网络抗干扰层：不绕过 hosts/加速器，直接按系统解析连接")
    ap.add_argument("--netguard-dns", default=",".join(netguard.DEFAULT_DNS),
                    help="抗干扰层使用的 DNS 服务器，逗号分隔")
    args = ap.parse_args()

    NET["tries"] = max(1, args.tries)
    NET["api_timeout"] = max(10, args.api_timeout)
    NET["deadline"] = max(30, args.api_deadline)

    if not TOKEN:
        print("✗ 没有找到 GH_TOKEN 环境变量。请先设置，例如：")
        print('   $env:GH_TOKEN = "ghp_xxx"        # 或使用具有 repo 权限的 fine-grained token')
        sys.exit(2)

    print(f"仓库   : {REPO}  ({BRANCH})")
    print(f"本地   : {LOCAL}")
    print(f"站点   : {SITE}")

    site_host = SITE.split("//", 1)[1].split("/", 1)[0]
    if args.no_netguard:
        print("抗干扰 : 已关闭（--no-netguard），按系统解析连接")
    else:
        servers = tuple(s.strip() for s in args.netguard_dns.split(",") if s.strip())
        rows = netguard.install(extra=(site_host,), servers=servers or netguard.DEFAULT_DNS)
        print("抗干扰 : 已启用（自建 DNS 解析真实 IP，绕开 hosts / 加速器 / IPv6 黑洞）")
        for host, ips, _system in rows:
            shown = ", ".join(ips[:3]) + (" …" if len(ips) > 3 else "")
            flag = "   ← 系统解析已被接管，已绕过" if netguard.hijacked(host) else ""
            print(f"         {host:<28} -> {shown}{flag}")
        for host in ("api.github.com", site_host):
            if not netguard.resolved(host):
                print(f"         ! {host} 拿不到真实 IP，将回退到系统解析（可能被加速器接管）")
        for warn in netguard.warnings():
            print(f"         ! {warn}")

    print("\n[1/4] 比对差异 …")
    head, tree_sha, remote, changed, added, crlf_only, deleted, too_big = diff()
    print(f"  线上 HEAD {head[:10]}   线上文件 {len(remote)} 个")

    if too_big:
        print("\n✗ 有文件超过 GitHub 的 100MB 限制，已终止：")
        for rel, size in too_big:
            print(f"    {rel}  {size / 1048576:.1f} MB")
        sys.exit(2)

    print(f"\n  真实变化 : {len(changed) + len(added)} 个")
    for rel, size in changed:
        print(f"    ~ {rel}  ({size} B)")
    for rel, size in added:
        print(f"    + {rel}  ({size} B)")
    junk = [r for r, s in added if s == 0 and not os.path.basename(r).startswith(".")]
    if junk:
        print("\n  ! 注意：以下新增文件是 0 字节，可能不是有意创建的（.nojekyll 之类的点文件不受影响）：")
        for r in junk:
            print(f"      {r}")
        print("    如确属误建，请先删除再发布，或用 --check 复核。")
    if crlf_only:
        print(f"  仅换行符差异（忽略）: {len(crlf_only)} 个")
    up = sum(s for _, s in changed + added)
    if up:
        print(f"  需上传   : {up / 1048576:.2f} MB"
              f"（实测上行 20~140 KB/s，约 {up / 1024 / 100 / 60:.1f} 分钟）")
    if deleted:
        tag = "将删除" if args.allow_delete else "线上多出（默认保留）"
        print(f"  {tag}: {len(deleted)} 个")
        for rel in deleted[:20]:
            print(f"    - {rel}")

    if not changed and not added and not (deleted and args.allow_delete):
        print("\n✓ 线上就是最新的，无需发布。抽查线上页面：")
        verify([], published=False)
        return

    if args.check:
        print("\n[--check] 预演结束，未做任何提交。")
        return

    print("\n[2/4] 提交到仓库 …")
    entries = []
    for rel, _ in changed + added:
        data = payload_bytes(os.path.join(LOCAL, rel.replace("/", os.sep)), rel, rel in remote)
        blob = api("POST", f"/repos/{REPO}/git/blobs",
                   {"content": base64.b64encode(data).decode("ascii"), "encoding": "base64"},
                   timeout=300, deadline=900)   # 单个 blob 最大约 1MB，base64 后 1.33MB
        entries.append({"path": rel, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print(f"    blob {rel}  {blob['sha'][:10]}")
    if args.allow_delete:
        for rel in deleted:
            entries.append({"path": rel, "mode": "100644", "type": "blob", "sha": None})

    tree = api("POST", f"/repos/{REPO}/git/trees", {"base_tree": tree_sha, "tree": entries})
    msg = args.message.strip()
    if not msg:
        names = [r for r, _ in changed] + [r for r, _ in added]
        head3 = "、".join(os.path.basename(n) for n in names[:3])
        more = f" 等 {len(names)} 个文件" if len(names) > 3 else ""
        msg = f"更新：{head3}{more}\n\n改动：\n" + "\n".join(
            [f"- 修改 {r}" for r, _ in changed] + [f"- 新增 {r}" for r, _ in added])
    commit = api("POST", f"/repos/{REPO}/git/commits",
                 {"message": msg, "tree": tree["sha"], "parents": [head]})
    api("PATCH", f"/repos/{REPO}/git/refs/heads/{BRANCH}", {"sha": commit["sha"], "force": False})
    print(f"    commit {commit['sha'][:10]}   已更新 {BRANCH}")

    print(f"\n[3/4] 等 GitHub Pages 构建（最多 {args.timeout}s）…")
    deadline = time.time() + args.timeout
    built = False
    tried_trigger = False
    while time.time() < deadline:
        time.sleep(8)
        try:
            b = api("GET", f"/repos/{REPO}/pages/builds/latest")
        except Exception as e:
            print("    查询构建状态失败：", e)
            continue
        st, bc = b.get("status"), (b.get("commit") or "")[:10]
        print(f"    status={st:<9} commit={bc:<11} duration={b.get('duration')}ms")
        if st == "built" and bc == commit["sha"][:10]:
            built = True
            break
        if st == "errored":
            print("    ! 构建失败：", b.get("error", {}).get("message"))
            break
        if not tried_trigger and time.time() - (deadline - args.timeout) > 45:
            tried_trigger = True
            try:
                api("POST", f"/repos/{REPO}/pages/builds")
                print("    已尝试手动触发一次构建")
            except Exception as e:
                print("    手动触发不可用（token 无 Pages 写权限，属正常）：", str(e)[:120])
    if not built:
        print("    ! 超时未确认构建完成，仍尝试验证线上。")

    print("\n[4/4] 验证线上 …")
    verify([r for r, _ in changed + added], full=args.verify_full)


def live_url(rel):
    return SITE + "/".join(urllib.parse.quote(seg) for seg in rel.split("/"))


HEAD_ONLY = 256 * 1024      # 超过这个尺寸的索引文件默认不做整份下载校验


def verify(rels, published=True, full=False):
    """校验线上文件。

    【为什么大文件改成只比大小】实测本机到 *.github.io 只有 20~35 KB/s，
    21 个全文索引合计 3.9MB，整份下载再算 sha256 光传输就要 2~3 分钟，
    而这批文件每次重建都会整体重写（见 build-index.js），等于每次发布都白等。
    现在：页面等小文件仍然逐字节 sha256 比对；超过 HEAD_ONLY 的索引文件只比对
    Content-Length（GitHub Pages 的 HEAD 带精确字节数，实测与本地一致）。
    要恢复逐字节校验就加 --verify-full。
    """
    targets = [r for r in rels if os.path.splitext(r)[1].lower() in VERIFY_EXT]
    if not targets:
        targets = ["index.html"]
    ok, fail, headok = [], [], []
    for rel in targets:
        path = os.path.join(LOCAL, rel.replace("/", os.sep))
        if not os.path.exists(path):
            continue
        raw = payload_bytes(path, rel, True)
        url = live_url(rel)
        if not full and len(raw) > HEAD_ONLY:
            want_len = str(len(raw))
            got_len = None
            for _ in range(3):
                try:
                    got_len = head_len(url)
                    if got_len == want_len:
                        break
                except Exception as e:
                    got_len = f"ERR {e}"
                time.sleep(3)
            if got_len == want_len:
                headok.append(rel)
                print(f"    ✓ {rel}  (HEAD 大小一致 {want_len} B，跳过整份下载)")
            else:
                fail.append(rel)
                print(f"    ✗ {rel}  期望 {want_len} B 实际 {got_len}")
            continue
        want = hashlib.sha256(raw).hexdigest()
        got = None
        for _ in range(2):
            try:
                body = fetch(url + "?__cb=" + str(int(time.time() * 1000)))
                got = hashlib.sha256(body).hexdigest()
                if got == want:
                    break
            except Exception as e:
                got = f"ERR {e}"
            time.sleep(5)
        if got == want:
            ok.append(rel)
            print(f"    ✓ {rel}")
        else:
            fail.append(rel)
            print(f"    ✗ {rel}  期望 {want[:10]} 实际 {str(got)[:24]}")
    print()
    if fail:
        print(f"⚠ 有 {len(fail)} 个文件未在线上校验通过（可能是 CDN 缓存，稍后刷新即可）：")
        for r in fail:
            print("   ", live_url(r))
    elif published:
        print(f"✓ 发布完成并验证通过：{SITE}")
        print(f"  逐字节校验 {len(ok)} 个，HEAD 大小校验 {len(headok)} 个。")
    else:
        print(f"✓ 线上内容与本地一致：{SITE}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已中断")
        sys.exit(130)
    except Exception as e:
        print(f"\n✗ 发布失败：{type(e).__name__}: {e}")
        sys.exit(1)
