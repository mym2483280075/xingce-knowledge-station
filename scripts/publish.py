# -*- coding: utf-8 -*-
"""
行测知识工作站 · 一键发布到 GitHub Pages

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
"""
import sys, io, os, re, json, time, base64, hashlib, argparse, urllib.parse
import urllib.request, urllib.error

# ---------- 输出与配置 ----------
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass

TOKEN = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
REPO = os.environ.get("XS_REPO", "mym2483280075/xingce-knowledge-station")
BRANCH = os.environ.get("XS_BRANCH", "main")
HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL = os.environ.get("XS_LOCAL", os.path.dirname(HERE))

TEXT_EXT = {".html", ".htm", ".css", ".js", ".mjs", ".json", ".md", ".txt", ".svg",
            ".xml", ".yml", ".yaml", ".csv", ".map", ".ts", ".jsx", ".tsx", ".py"}
VERIFY_EXT = TEXT_EXT | {".cmd", ".bat", ".ps1", ".sh"}
SKIP_DIRS = {".git", "__pycache__", "node_modules", ".idea", ".vscode"}
SITE = f"https://{REPO.split('/')[0]}.github.io/{REPO.split('/')[1]}/"

API = "https://api.github.com"


# ---------- HTTP ----------
def api(method, path, body=None, retries=4, timeout=180):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={"Authorization": "Bearer " + TOKEN, "User-Agent": "xs-publish",
                 "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json; charset=utf-8"})
    last = None
    for i in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:400]
            last = f"HTTP {e.code}: {detail}"
            if e.code in (401, 403, 404, 409, 422):
                break
        except Exception as e:
            last = f"{type(e).__name__}: {e}"
        time.sleep(3 * (i + 1))
    raise RuntimeError(f"{method} {path} 失败 → {last}")


def fetch(url, timeout=60, tries=1):
    req = urllib.request.Request(url, headers={"User-Agent": "xs-publish", "Cache-Control": "no-cache"})
    last = None
    for _ in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:
            last = e
            time.sleep(5)
    raise RuntimeError(f"抓取失败 {url} → {type(last).__name__}: {last}")


# ---------- 哈希 ----------
def blob_sha(data: bytes) -> str:
    h = hashlib.sha1()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


def local_files():
    out = {}
    for root, dirs, files in os.walk(LOCAL):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
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
    tree = api("GET", f"/repos/{REPO}/git/trees/{tree_sha}?recursive=1")
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
    args = ap.parse_args()

    if not TOKEN:
        print("✗ 没有找到 GH_TOKEN 环境变量。请先设置，例如：")
        print('   $env:GH_TOKEN = "ghp_xxx"        # 或使用具有 repo 权限的 fine-grained token')
        sys.exit(2)

    print(f"仓库   : {REPO}  ({BRANCH})")
    print(f"本地   : {LOCAL}")
    print(f"站点   : {SITE}")
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
                   {"content": base64.b64encode(data).decode("ascii"), "encoding": "base64"})
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
    verify([r for r, _ in changed + added])


def live_url(rel):
    return SITE + "/".join(urllib.parse.quote(seg) for seg in rel.split("/"))


def verify(rels, published=True):
    targets = [r for r in rels if os.path.splitext(r)[1].lower() in VERIFY_EXT]
    if not targets:
        targets = ["index.html"]
    ok, fail = [], []
    for rel in targets:
        path = os.path.join(LOCAL, rel.replace("/", os.sep))
        if not os.path.exists(path):
            continue
        want = hashlib.sha256(payload_bytes(path, rel, True)).hexdigest()
        url = live_url(rel)
        got = None
        for _ in range(8):
            try:
                body = fetch(url + "?__cb=" + str(int(time.time() * 1000)))
                got = hashlib.sha256(body).hexdigest()
                if got == want:
                    break
            except Exception as e:
                got = f"ERR {e}"
            time.sleep(10)
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
        print(f"  本次校验 {len(ok)} 个文件，字节级一致。")
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
