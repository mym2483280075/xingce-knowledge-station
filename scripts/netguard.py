# -*- coding: utf-8 -*-
"""网络抗干扰层：让发布与下载绕开 hosts、加速器、代理环境变量和 IPv6 黑洞。

【为什么需要这一层 · 2026-09-20 实测】
  · Watt Toolkit 的 GitHub 加速会把 api.github.com 写进 hosts 指向 127.0.0.1：
    小请求确实变快（339ms -> 123ms），但 295KB 的 tree 响应 2/2 全部 40s 超时，
    publish.py --check 从 16.7s 变成 105.5s 并直接失败。
  · 直连虽然能成，但同一条链路 1/2 概率卡死（半开连接），实测 87s 无响应。
  · 这两种故障的共同点是：拿到哪个地址、走哪条链路，全都不受我们控制。

【做法】不信任系统的任何解析结果：
  1) 自己用 UDP 直接问公共 DNS（223.5.5.5 / 119.29.29.29 / 114.114.114.114），
     hosts 文件对它无效；响应被截断时自动改走 TCP。
  2) 过滤掉回环/私有/保留地址——加速器接管域名时返回的正是 127.0.0.1。
  3) patch socket.getaddrinfo：只对清单内的域名生效，并强制 IPv4，
     避免 AAAA 记录存在但 IPv6 不通时连接干等。
  4) rotate()：上层重试时切换到下一个真实 IP，绕开某一条半开链路。

本模块只改本进程内的解析行为，不写系统设置、不动 hosts，可随时 uninstall()。
"""

import ipaddress
import random
import socket
import struct
import threading

DEFAULT_DNS = ("223.5.5.5", "119.29.29.29", "114.114.114.114")

# 默认接管的域名：GitHub 发布链路 + 站点 CDN
DEFAULT_HOSTS = (
    "api.github.com",
    "github.com",
    "codeload.github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "uploads.github.com",
)

_QTYPE_A = 1
_QCLASS_IN = 1

_orig_getaddrinfo = socket.getaddrinfo
_lock = threading.Lock()
_cache = {}          # host -> [ip, ...]（真实解析结果）
_map = {}            # host -> [ip, ...]（已安装的接管映射）
_rr = {}             # host -> 轮换游标
_report = []         # [(host, real_ips, system_ips), ...]
_warnings = []
_installed = False


# ---------- 地址判定 ----------
def is_bad(ip: str) -> bool:
    """回环/私有/保留地址都视为「被接管或不可用」。"""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return True
    return (a.is_loopback or a.is_private or a.is_link_local
            or a.is_multicast or a.is_reserved or a.is_unspecified)


# ---------- 极简 DNS 客户端（只查 A 记录，无第三方依赖） ----------
def _build_query(name: str, tid: int) -> bytes:
    header = struct.pack(">HHHHHH", tid, 0x0100, 1, 0, 0, 0)
    qname = b"".join(bytes([len(p)]) + p.encode("ascii") for p in name.split(".")) + b"\x00"
    return header + qname + struct.pack(">HH", _QTYPE_A, _QCLASS_IN)


def _skip_name(data: bytes, i: int) -> int:
    while True:
        length = data[i]
        if length == 0:
            return i + 1
        if length & 0xC0 == 0xC0:      # 压缩指针
            return i + 2
        i += length + 1


def _parse_response(data: bytes):
    """返回 (IPv4 列表, 是否被截断)。"""
    if len(data) < 12:
        raise ValueError("DNS 响应过短")
    _tid, flags, qd, an, _ns, _ar = struct.unpack(">HHHHHH", data[:12])
    i = 12
    for _ in range(qd):
        i = _skip_name(data, i) + 4
    ips = []
    for _ in range(an):
        i = _skip_name(data, i)
        rtype, _rclass, _ttl, rdlen = struct.unpack(">HHIH", data[i:i + 10])
        i += 10
        if rtype == _QTYPE_A and rdlen == 4:
            ips.append(".".join(str(b) for b in data[i:i + 4]))
        i += rdlen
    return ips, bool(flags & 0x0200)


def _query_udp(server: str, name: str, timeout: float):
    tid = random.randrange(1, 0xFFFF)
    pkt = _build_query(name, tid)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(pkt, (server, 53))
        data, _ = sock.recvfrom(4096)
    finally:
        sock.close()
    ips, truncated = _parse_response(data)
    if truncated:
        return _query_tcp(server, name, timeout)
    return ips


def _query_tcp(server: str, name: str, timeout: float):
    tid = random.randrange(1, 0xFFFF)
    pkt = _build_query(name, tid)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((server, 53))
        sock.sendall(struct.pack(">H", len(pkt)) + pkt)
        need = struct.unpack(">H", sock.recv(2))[0]
        buf = b""
        while len(buf) < need:
            chunk = sock.recv(need - len(buf))
            if not chunk:
                break
            buf += chunk
    finally:
        sock.close()
    ips, _ = _parse_response(buf)
    return ips


def real_ips(host: str, servers=DEFAULT_DNS, timeout: float = 4.0):
    """用自建 DNS 拿真实地址；hosts 文件与系统缓存都不参与。"""
    if host in _cache:
        return list(_cache[host])
    problems = []
    for server in servers:
        try:
            ips = [ip for ip in _query_udp(server, host, timeout) if not is_bad(ip)]
        except Exception as exc:
            problems.append(f"{server} 查询失败({type(exc).__name__})")
            continue
        if ips:
            uniq = list(dict.fromkeys(ips))
            _cache[host] = uniq
            return uniq
        problems.append(f"{server} 只返回被过滤的地址（疑似被 hosts/加速器接管）")
    raise RuntimeError("无法解析 " + host + "：" + "；".join(problems))


# ---------- 接管 socket 解析 ----------
def _patched_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    ips = _map.get(host)
    if ips:
        with _lock:
            cursor = _rr.get(host, 0)
        ip = ips[cursor % len(ips)]
        return _orig_getaddrinfo(ip, port, socket.AF_INET, type, proto, flags)
    return _orig_getaddrinfo(host, port, family, type, proto, flags)


def install(hosts=None, extra=(), servers=DEFAULT_DNS, timeout: float = 4.0):
    """解析清单内域名并接管 socket。返回 [(host, 真实 IP, 系统 IP), ...]。"""
    global _installed
    with _lock:
        if _installed:
            return list(_report)
        targets = list(dict.fromkeys(list(hosts or DEFAULT_HOSTS) + [h for h in extra if h]))
        for host in targets:
            try:
                ips = real_ips(host, servers=servers, timeout=timeout)
            except Exception as exc:
                _warnings.append(f"{host}: {exc}")
                continue
            try:
                system = sorted({info[4][0] for info in _orig_getaddrinfo(host, 443, socket.AF_INET)})
            except Exception:
                system = []
            # 把系统解析里「没被接管」的地址也并进候选表，放在自建解析之后。
            # 这样自建 DNS 挑到一条慢链路时，重试还能退回到系统给的地址，
            # 保证「开了抗干扰」永远不会比「直接连」更差。
            extra_ips = [ip for ip in system if ip not in ips and not is_bad(ip)]
            _map[host] = ips + extra_ips
            _rr[host] = 0
            _report.append((host, _map[host], system))
        socket.getaddrinfo = _patched_getaddrinfo
        _installed = True
        return list(_report)


def uninstall():
    global _installed
    socket.getaddrinfo = _orig_getaddrinfo
    _installed = False


def rotate(host: str):
    """重试前调用：下一条连接换用下一个真实 IP。"""
    with _lock:
        if host in _rr:
            _rr[host] = _rr.get(host, 0) + 1


def resolved(host: str):
    return list(_map.get(host, []))


def hijacked(host: str):
    """系统解析是否被 hosts/加速器接管（用于提示）。"""
    try:
        system = {info[4][0] for info in _orig_getaddrinfo(host, 443, socket.AF_INET)}
    except Exception:
        return False
    return bool(system) and all(is_bad(ip) for ip in system)


def warnings():
    return list(_warnings)
