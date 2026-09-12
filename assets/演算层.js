/* =========================================================
   行测知识工作站 · 全局演算层（透明手写画布）
   用途：在任意板块页面上叠加一层几乎全透明的画布，透过它看题目、随手演算。

   笔迹几何：perfect-freehand（github.com/steveruizok/perfect-freehand, MIT）
     · 每一笔交给 getStroke() 生成一个闭合轮廓多边形，再用一次 fill() 出墨。
     · 一次填充只有一个 coverage 掩膜，笔迹内部不存在“分段接缝”，
       结构上不会出现条纹/板条状伪影（这也正是 tldraw 的生产做法）。
     · 压感由轮廓宽度体现，满压时宽度正好等于用户设定的粗细。
     · 库未加载成功时退化为“一条整路径 + 恒定宽度描边”，同样不分段。

   低内存设计（沿用并加强）：
     1) 单画布，只做视口大小（不是整页高度），无离屏副本
     2) 笔画是唯一数据源，坐标用 Float32Array 紧凑存（x,y,压力 各 4 字节）
     3) 撤销栈只存引用与上一版坐标，不存 ImageData 位图快照，并限制深度
     4) devicePixelRatio 上限 2，3x 屏可省一半以上像素内存
     5) 书写中只重画“当前这一笔的包围盒”（矩形边界对齐到整像素，避免抗锯齿接缝）；
        笔画按视口可视范围过滤，页面再长也不额外吃内存
     6) 页面隐藏/切走时释放画布缓冲；零第三方依赖
   坐标：一律用“文档坐标”（滚动后依然贴在同一道题旁边），渲染时整体平移 scrollY。

   苹果手写笔（Apple Pencil）适配要点：
     a) 走 Pointer Events：pointerType==='pen' 时读取 pressure 作为压感，力度直接决定线条粗细
     b) 防误触（手掌抑制）：笔落下后的一段时间内忽略所有触摸输入；手写笔一旦出现，
        自动进入「仅手写笔」模式（可手动关闭），贴在屏幕上的手掌不会再画出杂线
     c) 笔尖悬停（iPad Pro M2+ / iPadOS 16.4+）：未落笔也能看到笔尖粗细预览圈
     d) 合批事件：只吃 pointermove（内含 getCoalescedEvents 的全部原始采样点），线条更顺滑；
        刻意不同时监听 pointerrawupdate —— 它和 pointermove 是两条流，
        同时处理会把同一批样本推两遍，笔迹来回折返成锯齿（桌面端/安卓的“栅栏条纹”根因）
     e) 某些笔（或手指）根本不报压力：自动识别为“无压感”，按满压渲染，
        保证线宽严格等于用户设定的粗细，不擅自改粗改细
     f) 双指平移：演算模式下画布接管了单指，双指捏合/拖动仍可上下翻页
     g) touch-action/overscroll 处理，避免手写时页面跟着滚动或被 iOS 回弹打断
     h) 位图尺寸以画布真实 CSS 盒子为准，捏合放大/浏览器缩放后自动对齐：
        否则位图会被浏览器拉伸显示，笔迹会整体放大（看起来“过粗”）
   ========================================================= */
(function () {
  'use strict';
  if (window.__xzScratchLoaded) return;
  window.__xzScratchLoaded = true;

  /* 本脚本自己的 URL：用来定位同目录下的 perfect-freehand（各板块页层级不同） */
  var SELF = '';
  try {
    var _s = document.currentScript;
    if (!_s) { var _a = document.getElementsByTagName('script'); _s = _a[_a.length - 1]; }
    if (_s && _s.src) SELF = _s.src.replace(/[?#].*$/, '');
  } catch (e) {}
  var ASSET_DIR = SELF ? SELF.replace(/[^\/]*$/, '') : '../assets/';

  /* devicePixelRatio 必须动态取：浏览器缩放、窗口跨屏、iPad 捏合都会改变它。
     启动时读一次并缓存，会导致画布位图和显示尺寸对不上。 */
  function curDPR() { return Math.min(window.devicePixelRatio || 1, 2); }
  var MAX_PTS = 12000, PT_MIN = 0.35, MAX_UNDO = 120;
  var FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
  var PREF_KEY = 'xz-ink-pref';

  /* 颜色板：夜晚模式下换成亮色，写在深色底上才看得清 */
  var PALETTE_LIGHT = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b'];
  var PALETTE_DARK = ['#e8eff9', '#ff6b6b', '#5b9cff', '#4ade80', '#fbbf24'];
  var PALETTE_NAME = ['黑', '红', '蓝', '绿', '橙'];
  var PALETTE_NAME_DARK = ['白', '红', '蓝', '绿', '橙'];

  /* 各工具的粗细区间与预设（像素，指屏幕上实际线宽） */
  var WCFG = {
    pen: { min: 0.6, max: 14, def: 2.2, presets: [1.2, 2.4, 4.5, 8] },
    pencil: { min: 0.5, max: 9, def: 1.6, presets: [1, 2, 3.5, 6] },
    marker: { min: 8, max: 48, def: 20, presets: [12, 20, 32, 44] },
    eraser: { min: 8, max: 80, def: 18, presets: [10, 20, 40, 70] }
  };
  var TOOL_LABEL = { pen: '钢笔', pencil: '铅笔', marker: '荧光', eraser: '橡皮', pick: '指针' };

  /* ---------- 主题（夜晚模式）感知 ---------- */
  function themeDark() {
    var t = window.__xzTheme;
    if (t && typeof t.isDark === 'function') { try { return !!t.isDark(); } catch (e) {} }
    var de = document.documentElement;
    if (de && de.classList && de.classList.contains('xz-dark')) return true;
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e2) { return false; }
  }
  var dark = themeDark();
  function palette() { return dark ? PALETTE_DARK : PALETTE_LIGHT; }
  function paletteName() { return dark ? PALETTE_NAME_DARK : PALETTE_NAME; }

  /* ---------- 偏好（只存设置，不存笔迹） ---------- */
  var pref = (function () {
    var d = { tool: 'pen', penOnly: false, color: { pen: 0, pencil: 0, marker: 4, eraser: -1 }, w: {} };
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(PREF_KEY) || 'null'); } catch (e) { raw = null; }
    if (raw && typeof raw === 'object') {
      if (TOOL_LABEL[raw.tool]) d.tool = raw.tool;
      if (typeof raw.penOnly === 'boolean') d.penOnly = raw.penOnly;
      if (raw.color && typeof raw.color === 'object') {
        ['pen', 'pencil', 'marker'].forEach(function (k) {
          var v = raw.color[k];
          if (typeof v === 'number' && v >= 0 && v <= 4) d.color[k] = v;
        });
      }
      if (raw.w && typeof raw.w === 'object') {
        Object.keys(WCFG).forEach(function (k) {
          var v = raw.w[k];
          if (typeof v === 'number' && v >= WCFG[k].min && v <= WCFG[k].max) d.w[k] = v;
        });
      }
    }
    return d;
  })();
  function savePref() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        tool: pref.tool, penOnly: pref.penOnly,
        color: pref.color,
        w: { pen: state.pen.w, pencil: state.pencil.w, marker: state.marker.w, eraser: state.eraser.w }
      }));
    } catch (e) {}
  }

  /* ---------- 构建隔离的 UI（Shadow DOM，不污染板块页样式） ---------- */
  var host = document.createElement('div');
  host.setAttribute('data-xz-scratch', '');
  host.setAttribute('data-theme', dark ? 'dark' : 'light');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
  var root = host.attachShadow({ mode: 'open' });

  root.innerHTML =
    '<style>' +
    '*{box-sizing:border-box}' +
    ':host{--ui-bg:rgba(255,255,255,.96);--ui-bg2:#f1f5f9;--ui-ink:#0f172a;--ui-ink2:#475569;--ui-ink3:#94a3b8;' +
      '--ui-line:rgba(15,23,42,.10);--ui-hi:#1d6fb8;--ui-chip:#ffffff;--ui-warn:#c0392b;' +
      '--ui-shadow:0 12px 32px -16px rgba(15,23,42,.6),0 0 0 1px rgba(15,23,42,.08);--ui-r:16px}' +
    ':host([data-theme="dark"]){--ui-bg:rgba(20,29,45,.97);--ui-bg2:#22304a;--ui-ink:#e8eff9;--ui-ink2:#b6c3d4;' +
      '--ui-ink3:#8b9bb1;--ui-line:rgba(148,163,184,.20);--ui-hi:#7fb2ff;--ui-chip:#2b3a56;--ui-warn:#ff9b96;' +
      '--ui-shadow:0 14px 34px -16px rgba(0,0,0,.92),0 0 0 1px rgba(148,163,184,.18)}' +
    'canvas{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;' +
      'touch-action:none;overscroll-behavior:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-user-drag:none}' +
    'canvas.on{pointer-events:auto;cursor:crosshair}' +
    'canvas.pick{cursor:default}' +
    '.ring{position:absolute;left:0;top:0;border-radius:50%;border:1.5px solid currentColor;color:var(--ui-hi);' +
      'pointer-events:none;opacity:0;transform:translate(-50%,-50%);transition:opacity .14s;will-change:transform}' +
    '.ring.on{opacity:.85}' +
    '.fab{position:absolute;top:12px;right:14px;pointer-events:auto;border:0;border-radius:999px;padding:10px 16px;' +
      'font:600 13px/1 ' + FONT + ';color:#fff;background:rgba(29,111,184,.94);cursor:pointer;' +
      'box-shadow:0 8px 20px -10px rgba(15,23,42,.6);transition:background .18s,transform .14s;-webkit-tap-highlight-color:transparent}' +
    '.fab:hover{background:rgba(29,111,184,1)}' +
    '.fab:active{transform:scale(.97)}' +
    '.fab.live{background:rgba(100,116,139,.92)}' +
    ':host([data-theme="dark"]) .fab{background:rgba(58,110,178,.95)}' +
    '.fab.has::after{content:"";position:absolute;top:6px;right:9px;width:6px;height:6px;border-radius:50%;background:#f59e0b}' +
    '.bar{position:absolute;left:50%;bottom:calc(12px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);' +
      'display:none;flex-wrap:wrap;justify-content:center;align-items:center;gap:6px;' +
      'max-width:calc(100vw - 16px);max-height:56vh;overflow:auto;-webkit-overflow-scrolling:touch;' +
      'padding:7px 9px;border-radius:var(--ui-r);background:var(--ui-bg);pointer-events:auto;' +
      'box-shadow:var(--ui-shadow);-webkit-backdrop-filter:blur(22px) saturate(170%);backdrop-filter:blur(22px) saturate(170%);' +
      'font:400 13px/1 ' + FONT + ';color:var(--ui-ink)}' +
    '.bar.show{display:flex}' +
    '.grp{display:flex;align-items:center;gap:3px;padding:3px;border-radius:11px;background:var(--ui-bg2);flex:0 0 auto}' +
    '.grp.plain{background:transparent;padding:0}' +
    '.bar button{border:0;background:transparent;color:var(--ui-ink2);font:600 12.5px/1 ' + FONT + ';' +
      'padding:8px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;min-height:34px;-webkit-tap-highlight-color:transparent}' +
    '.bar button:hover{background:var(--ui-chip)}' +
    '.bar button.on{background:var(--ui-chip);color:var(--ui-hi);box-shadow:0 1px 3px rgba(15,23,42,.16)}' +
    '.bar button.warn{color:var(--ui-warn)}' +
    '.lb{color:var(--ui-ink3);font-size:11.5px;padding:0 4px;white-space:nowrap}' +
    '.wsl{-webkit-appearance:none;appearance:none;width:104px;height:30px;background:transparent;margin:0;flex:0 0 auto;cursor:pointer}' +
    '.wsl::-webkit-slider-runnable-track{height:6px;border-radius:999px;background:rgba(128,140,160,.38)}' +
    '.wsl::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;margin-top:-8px;border-radius:50%;' +
      'background:var(--ui-hi);border:0;box-shadow:0 1px 6px rgba(0,0,0,.4)}' +
    '.wsl::-moz-range-track{height:6px;border-radius:999px;background:rgba(128,140,160,.38)}' +
    '.wsl::-moz-range-thumb{width:20px;height:20px;border:0;border-radius:50%;background:var(--ui-hi)}' +
    '.wpre{display:flex;align-items:center;gap:2px;flex:0 0 auto}' +
    '.wprev{display:flex;align-items:center;gap:6px;flex:0 0 auto;padding:0 6px 0 2px;min-width:64px}' +
    '.wdot{border-radius:50%;background:currentColor;flex:none;box-shadow:0 0 0 1px var(--ui-line)}' +
    '.wnum{font:600 11.5px/1 ' + FONT + ';color:var(--ui-ink3);font-variant-numeric:tabular-nums}' +
    '.sws{display:flex;align-items:center;gap:5px;padding:3px;border-radius:11px;background:var(--ui-bg2);flex:0 0 auto}' +
    '.sw{width:23px;height:23px;border-radius:50%;border:2px solid var(--ui-bg);box-shadow:0 0 0 1px var(--ui-line);cursor:pointer;padding:0;flex:none}' +
    '.sw.on{box-shadow:0 0 0 2px var(--ui-hi)}' +
    '.hint{color:var(--ui-ink3);font-size:11px;padding:0 4px;white-space:nowrap}' +
    '.toast{position:absolute;left:50%;bottom:calc(72px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);' +
      'background:rgba(15,23,42,.9);color:#fff;font:400 12.5px/1.35 ' + FONT + ';padding:9px 15px;border-radius:999px;' +
      'opacity:0;transition:opacity .22s;pointer-events:none;max-width:calc(100vw - 32px);text-align:center}' +
    ':host([data-theme="dark"]) .toast{background:rgba(226,232,240,.94);color:#101828}' +
    '.toast.on{opacity:1}' +
    '@media(max-width:900px){' +
      '.bar{bottom:calc(8px + env(safe-area-inset-bottom,0px));gap:5px;padding:6px 7px;border-radius:18px;max-width:calc(100vw - 12px)}' +
      '.bar button{min-height:40px;padding:10px 11px;font-size:12.5px}' +
      '.wsl{width:112px;height:36px}' +
      '.wsl::-webkit-slider-thumb{width:24px;height:24px;margin-top:-9px}' +
      '.sw{width:27px;height:27px}' +
      '.hint{display:none}' +
      '.fab{top:10px;right:10px;padding:11px 17px;font-size:13.5px}' +
      '.toast{bottom:calc(120px + env(safe-area-inset-bottom,0px))}' +
    '}' +
    '@media(max-width:400px){.lb{display:none}}' +
    '</style>' +
    '<canvas id="cv"></canvas>' +
    '<div class="ring" id="ring"></div>' +
    '<div class="bar" id="bar">' +
      '<div class="grp" id="tools">' +
        '<button type="button" data-tool="pen" title="钢笔：手写笔压感控制粗细">钢笔</button>' +
        '<button type="button" data-tool="pencil" title="铅笔：等宽轻描">铅笔</button>' +
        '<button type="button" data-tool="marker" title="荧光笔：半透明宽笔，划重点">荧光</button>' +
        '<button type="button" data-tool="eraser" title="橡皮擦：擦掉笔迹">橡皮</button>' +
        '<button type="button" data-tool="pick" title="指针：点选、拖动、删除笔画">指针</button>' +
        '<button type="button" id="penonly" title="仅手写笔：忽略手指与手掌，防止误触">仅笔</button>' +
      '</div>' +
      '<div class="grp" id="wgrp">' +
        '<span class="lb">粗细</span>' +
        '<input type="range" class="wsl" id="wsl" min="0" max="100" step="1" value="50" aria-label="笔迹粗细">' +
        '<span class="wprev" id="wprev"><i class="wdot" id="wdot"></i><b class="wnum" id="wnum">2.2</b></span>' +
        '<span id="wpresets" class="wpre"></span>' +
      '</div>' +
      '<div class="sws" id="colors"></div>' +
      '<div class="grp" id="hist">' +
        '<button type="button" id="undo" title="Ctrl+Z">撤销</button>' +
        '<button type="button" id="redo" title="Ctrl+Y">重做</button>' +
        '<button type="button" id="clear" class="warn">清空</button>' +
        '<button type="button" id="hidenote">收起</button>' +
      '</div>' +
      '<span class="hint" id="hint"></span>' +
    '</div>' +
    '<button type="button" class="fab" id="fab">演算</button>' +
    '<div class="toast" id="toast"></div>';
  (document.documentElement || document.body).appendChild(host);

  var cv = root.getElementById('cv'), ctx = cv.getContext('2d', { alpha: true });
  var bar = root.getElementById('bar'), fab = root.getElementById('fab'), ring = root.getElementById('ring');
  var toolsBox = root.getElementById('tools'), colorsBox = root.getElementById('colors'), presetsBox = root.getElementById('wpresets');
  var undoBtn = root.getElementById('undo'), redoBtn = root.getElementById('redo');
  var penOnlyBtn = root.getElementById('penonly'), wsl = root.getElementById('wsl');
  var wdot = root.getElementById('wdot'), wnum = root.getElementById('wnum'), hintEl = root.getElementById('hint');
  var toastEl = root.getElementById('toast');
  var toastTimer = 0;
  function toastMsg(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 1900);
  }

  /* ---------- 状态 ---------- */
  var W = 0, H = 0, scrollY = 0;
  var mode = false;
  var tool = TOOL_LABEL[pref.tool] ? pref.tool : 'pen';
  var state = {
    pen: { c: palette()[pref.color.pen], w: pref.w.pen || WCFG.pen.def },
    pencil: { c: palette()[pref.color.pencil], w: pref.w.pencil || WCFG.pencil.def },
    marker: { c: palette()[pref.color.marker], w: pref.w.marker || WCFG.marker.def },
    eraser: { w: pref.w.eraser || WCFG.eraser.def }
  };
  var strokes = [], undoStack = [], redoStack = [];
  var live = null, drawing = false, lastPr = 1, activeId = -1;
  var rafLive = 0, rafDraw = 0;
  var selected = null, drag = null, rectCache = null, resizeTimer = 0;

  /* 手写笔 / 防误触 / 双指平移 */
  var penSeen = 0, penId = -1, flatPress = false, flatToasted = false, prMin = 1, prMax = 0;
  var touches = [], panning = false, panLast = null, panTick = 0;

  /* ---------- 尺寸与坐标 ---------- */
  function readScroll() {
    scrollY = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }
  /* 画布位图必须严格等于「画布真实 CSS 盒子 × devicePixelRatio」。
     只认 window.innerWidth/innerHeight 会在 iPad 捏合放大、浏览器缩放、
     动态视口变化时与 CSS 盒子对不上：位图被浏览器拉伸显示，
     笔迹就会整体变大变粗（这正是 2 倍粗笔画的根因），还会有一大片写不上。
     所以尺寸一律以画布自己的 getBoundingClientRect() 为准。 */
  function sizeOf(el) {
    var r = el.getBoundingClientRect();
    var w = Math.round(r.width), h = Math.round(r.height);
    if (!(w > 0)) w = Math.round(document.documentElement.clientWidth || window.innerWidth || 1);
    if (!(h > 0)) h = Math.round(document.documentElement.clientHeight || window.innerHeight || 1);
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }
  function fitCanvas(s, d) {
    W = s.w; H = s.h;
    cv.width = Math.round(W * d);
    cv.height = Math.round(H * d);
    rectCache = null;
  }
  function resize() {
    fitCanvas(sizeOf(cv), curDPR());
  }
  /* 落笔/拖动前自检：尺寸或 DPR 变了就地补正，避免“位图被拉伸”这一类问题 */
  function ensureSize() {
    var s = sizeOf(cv), d = curDPR();
    if (cv.width !== Math.round(s.w * d) || cv.height !== Math.round(s.h * d) || W !== s.w || H !== s.h) {
      fitCanvas(s, d);
      readScroll();
      renderAll();
      return true;
    }
    return false;
  }
  function applyT() {
    var d = curDPR();
    ctx.setTransform(d, 0, 0, d, 0, -scrollY * d);
  }
  function ptOf(e) {
    if (!rectCache) rectCache = cv.getBoundingClientRect();
    return {
      x: e.clientX - rectCache.left,
      y: e.clientY - rectCache.top + scrollY,
      pr: (e.pointerType === 'pen') ? (e.pressure > 0 ? e.pressure : 0.5) : 1
    };
  }

  /* ---------- 几何 ---------- */
  /* s.w 就是“满压时的线宽”，所见即所得：钢笔轻按会变细，重按到设定的粗细封顶。
     轮廓在拐弯处会略微外扩，所以留一点额外余量给脏矩形与命中判定。 */
  function padOf(s) { return s.w * 0.5 + 4; }
  function computeBB(s) {
    var p = s.p, n = p.length / 3;
    if (!n) { s.bb = null; return; }
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < n; i++) {
      var x = p[i * 3], y = p[i * 3 + 1];
      if (x < x0) x0 = x; if (y < y0) y0 = y;
      if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    s.bb = { x0: x0, y0: y0, x1: x1, y1: y1 };
  }
  function hitBB(b, x0, y0, x1, y1, pad) {
    return !(b.x1 + pad < x0 || b.x0 - pad > x1 || b.y1 + pad < y0 || b.y0 - pad > y1);
  }
  function distToSeg(px, py, x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
    var t = l2 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var qx = x0 + t * dx - px, qy = y0 + t * dy - py;
    return Math.sqrt(qx * qx + qy * qy);
  }

  /* ---------- 笔迹几何：perfect-freehand（tldraw 作者维护，MIT） ----------
     旧做法是按压力把一笔切成很多小段、每段单独 stroke() 一次：
     段与段之间宽度突变，圆头相接处会出现半透明接缝，整笔看起来像一层层板条
     —— 也就是用户反馈的“斜向栅栏条纹”（恒定压力时只有一段，所以鼠标下看不出来）。
     现在改成把整笔交给 getStroke() 生成一个闭合轮廓多边形，再一次 fill() 出墨：
     一次填充只有一个coverage 掩膜，内部不存在分段接缝，结构上不可能出现条纹。
     库没加载上时退化成“一条整路径 + 恒定宽度描边”，同样不会分段。 */
  var PF = null, pfTried = false, pfLoading = false;
  function loadOutline() {
    if (pfTried || pfLoading) return;
    pfLoading = true;
    var urls = [
      /* 内置副本用 .js 后缀：GitHub Pages 对 .mjs 的 MIME 识别不可靠，
         而 ES 模块对 MIME 是严格校验的（内容仍是 ESM，import() 照常按模块解析） */
      ASSET_DIR + 'perfect-freehand.js',
      'https://cdn.jsdelivr.net/npm/perfect-freehand@1.2.3/dist/esm/index.mjs',
      'https://unpkg.com/perfect-freehand@1.2.3/dist/esm/index.mjs'
    ];
    var chain = Promise.reject();
    urls.forEach(function (u) { chain = chain.catch(function () { return import(u); }); });
    chain.then(function (mod) {
      PF = (mod && (typeof mod.getStroke === 'function' ? mod.getStroke
        : (mod.default && typeof mod.default.getStroke === 'function' ? mod.default.getStroke
          : (typeof mod.default === 'function' ? mod.default : null)))) || null;
    }).catch(function () { PF = null; }).then(function () {
      pfLoading = false; pfTried = true;
      if (mode) renderAll();          /* 加载完成后重画一次，老笔迹也升级成轮廓渲染 */
    });
  }

  var LIVE_IN = [];                   /* 复用容器，避免每帧重新分配点数组 */
  function prOf(s, i) { return (s.t === 'pen' && !s.flat) ? s.p[i * 3 + 2] : 1; }
  function inputPoints(s, reuse) {
    var p = s.p, n = p.length / 3, arr = reuse || [];
    /* 两点笔画：库内部会自行插值补充点，但那些补充点会丢掉压力值（回落到 0.5），
       结果线宽只有设定值的 ~71%。这里先自己补一个中点，绕开它那条分支。 */
    var need = (n === 2) ? 3 : n;
    arr.length = need;
    var j = 0;
    for (var i = 0; i < n; i++) {
      var q = arr[j];
      if (!q) { q = [0, 0, 0]; arr[j] = q; }
      q[0] = p[i * 3]; q[1] = p[i * 3 + 1]; q[2] = prOf(s, i);
      j++;
      if (i === 0 && n === 2) {
        var m = arr[j];
        if (!m) { m = [0, 0, 0]; arr[j] = m; }
        m[0] = (p[0] + p[3]) / 2; m[1] = (p[1] + p[4]) / 2;
        m[2] = (prOf(s, 0) + prOf(s, 1)) / 2;
        j++;
      }
    }
    return arr;
  }
  /* 各工具的轮廓参数。thinning 会同时影响粗细区间，
     所以 size 取 w/(1+thinning)，保证“满压时正好等于用户设定的宽度”。 */
  var OUT_CFG = {
    pen: { thinning: 0.4, smoothing: 0.5, streamline: 0.45 },
    pencil: { thinning: 0, smoothing: 0.42, streamline: 0.5 },
    marker: { thinning: 0, smoothing: 0.5, streamline: 0.62 }
  };
  function outlineOptions(s) {
    var o = OUT_CFG[s.t] || OUT_CFG.pen;
    var t = (s.t === 'pen' && !s.flat) ? o.thinning : 0;
    return {
      size: Math.max(0.6, s.w) / (1 + t),
      thinning: t,
      smoothing: o.smoothing,
      streamline: o.streamline,
      simulatePressure: false,
      last: true,
      start: { cap: true, taper: 0 },
      end: { cap: true, taper: 0 }
    };
  }
  /* 官方给出的“轮廓点 → SVG path”写法，这里原样使用 */
  function svgPathFromOutline(P) {
    var len = P.length;
    if (len < 4) { return ''; }
    var avg = function (a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
    var a = P[0], b = P[1], c = P[2], m = avg(b, c);
    var d = 'M' + a[0].toFixed(2) + ',' + a[1].toFixed(2) +
            'Q' + b[0].toFixed(2) + ',' + b[1].toFixed(2) + ' ' +
            m[0].toFixed(2) + ',' + m[1].toFixed(2) + 'T';
    for (var i = 2, max = len - 1; i < max; i++) {
      a = P[i]; b = P[i + 1];
      m = avg(a, b);
      d += m[0].toFixed(2) + ',' + m[1].toFixed(2) + ' ';
    }
    return d + 'Z';
  }

  /* ---------- 绘制 ---------- */
  function buildPath(s, i0, i1) {
    var p = s.p, n = p.length / 3, path = new Path2D(), aX, aY, bX, bY;
    for (var i = i0; i <= i1; i++) {
      if (i === 1) { aX = p[0]; aY = p[1]; }
      else { aX = (p[(i - 1) * 3] + p[i * 3]) / 2; aY = (p[(i - 1) * 3 + 1] + p[i * 3 + 1]) / 2; }
      var cX = p[i * 3], cY = p[i * 3 + 1];
      if (i === n - 1) { bX = cX; bY = cY; }
      else { bX = (p[i * 3] + p[(i + 1) * 3]) / 2; bY = (p[i * 3 + 1] + p[(i + 1) * 3 + 1]) / 2; }
      if (i === i0) path.moveTo(aX, aY);
      path.quadraticCurveTo(cX, cY, bX, bY);
    }
    return path;
  }
  function alphaOf(s) { return (s.t === 'pencil') ? 0.88 : (s.t === 'marker' ? 0.32 : 1); }
  /* 兜底渲染：一条整路径 + 恒定宽度描边（不分段，所以也不会出条纹） */
  function drawStrokeSimple(c, s) {
    var n = s.p.length / 3;
    if (!n) return;
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = alphaOf(s);
    c.strokeStyle = s.c; c.fillStyle = s.c;
    if (n === 1) {
      c.beginPath();
      c.arc(s.p[0], s.p[1], Math.max(s.w / 2, 0.5), 0, 6.2832);
      c.fill();
    } else {
      c.lineWidth = s.w;
      c.stroke(buildPath(s, 1, n - 1));
    }
    c.globalAlpha = 1;
  }
  function drawStroke(c, s) {
    var n = s.p.length / 3;
    if (!n) return;
    if (s.t === 'eraser') {                   /* 橡皮：整条路径描边 + 擦除合成 */
      c.lineCap = 'round'; c.lineJoin = 'round';
      c.globalCompositeOperation = 'destination-out';
      c.globalAlpha = 1; c.strokeStyle = '#000'; c.fillStyle = '#000';
      if (n === 1) {
        c.beginPath();
        c.arc(s.p[0], s.p[1], Math.max(s.w / 2, 0.5), 0, 6.2832);
        c.fill();
      } else {
        c.lineWidth = s.w;
        c.stroke(buildPath(s, 1, n - 1));
      }
      c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
      return;
    }
    if (!PF) { drawStrokeSimple(c, s); return; }
    if (n < 2) { drawStrokeSimple(c, s); return; }
    var path = s._p2d;
    if (!path) {
      var d = svgPathFromOutline(PF(inputPoints(s, s === live ? LIVE_IN : null), outlineOptions(s)));
      if (!d) { drawStrokeSimple(c, s); return; }
      path = new Path2D(d);
      if (s !== live) s._p2d = path;         /* 已提交的笔画缓存轮廓，整屏重画时零成本 */
    }
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = alphaOf(s);
    c.fillStyle = s.c;
    c.fill(path);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  }
  /* 局部重绘：只重画给定矩形里的内容。
     —— 两个关键点，都是为了让边缘不出伪影：
        1) 矩形先向外取整到“设备像素边界”，clearRect 与 clip 都落在整像素上。
           小数坐标的 clearRect 会被抗锯齿，每帧在矩形四边留下一圈半透明浅痕，
           写字时一圈圈叠起来就是“栅栏条纹”（WebKit 上尤其明显）。
        2) 清理与裁剪在恒等变换（设备像素）下做，画笔迹时再切回文档坐标。 */
  function paintRect(x0, y0, x1, y1) {
    var d = curDPR();
    var dx0 = Math.floor(x0 * d), dy0 = Math.floor((y0 - scrollY) * d);
    var dx1 = Math.ceil(x1 * d), dy1 = Math.ceil((y1 - scrollY) * d);
    if (dx1 <= dx0 || dy1 <= dy0) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(dx0, dy0, dx1 - dx0, dy1 - dy0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx0, dy0, dx1 - dx0, dy1 - dy0);
    ctx.clip();
    applyT();
    for (var i = 0; i < strokes.length; i++) {
      var s = strokes[i];
      if (!s.bb || !hitBB(s.bb, x0, y0, x1, y1, padOf(s))) continue;
      drawStroke(ctx, s);
    }
    if (live) drawStroke(ctx, live);          /* 正在写的那一笔也要跟着重画 */
    ctx.restore();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    applyT();
  }
  function drawSel(s) {
    var b = s.bb; if (!b) return;
    var pd = padOf(s) + 3;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = dark ? '#7fb2ff' : '#1d6fb8';
    ctx.strokeRect(b.x0 - pd, b.y0 - pd, (b.x1 - b.x0) + pd * 2, (b.y1 - b.y0) + pd * 2);
    ctx.restore();
  }
  /* 整屏重绘：必须把正在写的那一笔一起画上，
     否则书写途中任何一次整屏重画都会把它擦掉（只留下后续脏矩形补的碎片）。 */
  function renderAll() {
    readScroll();
    applyT();
    ctx.clearRect(0, scrollY, W, H);
    var y0 = scrollY, y1 = scrollY + H;
    for (var i = 0; i < strokes.length; i++) {
      var s = strokes[i];
      if (!s.bb || !hitBB(s.bb, 0, y0, W, y1, padOf(s))) continue;
      drawStroke(ctx, s);
    }
    if (live) drawStroke(ctx, live);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (selected) drawSel(selected);
  }
  function scheduleDraw() {
    if (rafDraw) return;
    rafDraw = requestAnimationFrame(function () { rafDraw = 0; renderAll(); });
  }

  /* ---------- 采样 ---------- */
  /* 反重放护栏：同一批原始样本被重复投喂时，新点会几乎精确落在前面某个已推过的点上。
     真人运笔不可能在几个采样点之内回到同一坐标，所以按“精确重合”丢点既安全又能挡住重复投递。 */
  function isReplay(s, x, y) {
    var p = s.p, n = p.length / 3, k = 0;
    for (var i = n - 1; i >= 0 && k < 6; i--, k++) {
      var dx = x - p[i * 3], dy = y - p[i * 3 + 1];
      if (dx * dx + dy * dy < 0.0025) return true;      /* 0.05px 内视为同一个采样点 */
    }
    return false;
  }
  function pushPoint(s, x, y, pr) {
    var n = s.p.length;
    if (n >= MAX_PTS * 3) return false;
    if (n >= 3) {
      var dx = x - s.p[n - 3], dy = y - s.p[n - 2];
      if (dx * dx + dy * dy < PT_MIN * PT_MIN) return false;
      if (isReplay(s, x, y)) return false;
    }
    if (s.t === 'pencil') { x += (Math.random() - 0.5) * 0.7; y += (Math.random() - 0.5) * 0.7; }
    if (s.t === 'marker') pr = 1;
    s.p.push(x, y, pr);
    if (pr < prMin) prMin = pr;
    if (pr > prMax) prMax = pr;
    var b = s.bb;
    if (!b) s.bb = { x0: x, y0: y, x1: x, y1: y };
    else { if (x < b.x0) b.x0 = x; if (y < b.y0) b.y0 = y; if (x > b.x1) b.x1 = x; if (y > b.y1) b.y1 = y; }
    return true;
  }
  /* 书写中的刷新：直接重画「整支笔迹的包围盒」。
     早先的做法是只擦“上一帧矩形 + 新点矩形”，一旦中途发生整屏重画（滚动 / 尺寸变化 /
     无压感笔判定）或矩形边缘被抗锯齿，就会留下鬼影与接缝条纹。
     整笔包围盒只有一个矩形、边界还在整像素上，写多久都不会出伪影；
     包围盒之外的内容本来就没被碰过，无需重画。 */
  function liveFrame() {
    rafLive = 0;
    if (!live || !live.bb) return;
    var sy = scrollY;
    readScroll();
    if (sy !== scrollY) { renderAll(); return; }   /* 页面滚过：整屏重画，避免墨迹错位 */
    var pd = padOf(live) + 1;
    var x0 = live.bb.x0 - pd, y0 = live.bb.y0 - pd, x1 = live.bb.x1 + pd, y1 = live.bb.y1 + pd;
    /* 包围盒已经铺满大半个屏幕时，直接整屏重画更省事（这么大的裁剪区没有意义） */
    if ((x1 - x0) * (y1 - y0) > W * H * 0.55) { renderAll(); return; }
    paintRect(x0, y0, x1, y1);
  }
  function scheduleLive() {
    if (rafLive) return;
    rafLive = requestAnimationFrame(liveFrame);
  }

  /* ---------- 笔尖悬停预览圈（Apple Pencil 悬停 / 鼠标） ---------- */
  function showRing(x, y, w) {
    ring.style.width = w + 'px';
    ring.style.height = w + 'px';
    ring.style.transform = 'translate(' + x + 'px,' + y + 'px) translate(-50%,-50%)';
    ring.classList.add('on');
  }
  function hideRing() { ring.classList.remove('on'); }

  /* ---------- 交互 ---------- */
  /* 指针模式不书写，但要有个“当前值”给粗细条/颜色板显示，统一落到钢笔上 */
  function activeState() { return state[tool] || state.pen; }
  function curColor() { return (tool === 'eraser') ? palette()[0] : activeState().c; }
  function curWidth() { return (tool === 'eraser') ? state.eraser.w : activeState().w; }
  function hitTest(x, y) {
    for (var i = strokes.length - 1; i >= 0; i--) {
      var s = strokes[i], b = s.bb;
      if (!b) continue;
      var pd = padOf(s) + 6;
      if (x < b.x0 - pd || x > b.x1 + pd || y < b.y0 - pd || y > b.y1 + pd) continue;
      var p = s.p, n = p.length / 3, lim = Math.max(s.w, 8) / 2 + 4;
      if (n === 1) {
        var dx = x - p[0], dy = y - p[1];
        if (dx * dx + dy * dy <= lim * lim) return s;
        continue;
      }
      for (var j = 1; j < n; j++) {
        if (distToSeg(x, y, p[(j - 1) * 3], p[(j - 1) * 3 + 1], p[j * 3], p[j * 3 + 1]) <= lim) return s;
      }
    }
    return null;
  }
  function translate(s, dx, dy) {
    var p = s.p;
    for (var i = 0; i < p.length; i += 3) { p[i] += dx; p[i + 1] += dy; }
    var b = s.bb;
    if (b) { b.x0 += dx; b.x1 += dx; b.y0 += dy; b.y1 += dy; }
    s._p2d = null;                                  /* 点动了，缓存的轮廓作废 */
  }

  /* 手写笔是否“正在使用中”（笔尖按着，或刚抬起不到 0.8 秒） */
  function penRecent() {
    return penId !== -1 || (penSeen !== 0 && (Date.now() - penSeen) < 800);
  }

  /* 触摸是否应当被忽略（手掌抑制） */
  function touchBlocked(e) {
    if (e.pointerType !== 'touch') return false;
    if (tool === 'pick') return false;                  /* 指针模式下手指定点选，属刻意操作 */
    if (pref.penOnly) return true;
    return penRecent();
  }

  /* 找当前可滚动的祖先（双指平移时用） */
  function scrollHost(x, y) {
    var el = null;
    cv.style.pointerEvents = 'none';
    try { el = document.elementFromPoint(x, y); } catch (err) { el = null; }
    cv.style.pointerEvents = '';
    var node = el;
    while (node && node !== document.body && node !== document.documentElement) {
      var st = null;
      try { st = window.getComputedStyle(node); } catch (err2) { st = null; }
      if (st && /(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 2) return node;
      node = node.parentElement;
    }
    return null;
  }
  function panBy(dx, dy, x, y) {
    if (!panTick) panTick = scrollHost(x, y);
    if (panTick) { panTick.scrollTop -= dy; panTick.scrollLeft -= dx; }
    else window.scrollBy(-dx, -dy);
    readScroll(); scheduleDraw();
  }
  function centroid() {
    var sx = 0, sy = 0;
    for (var i = 0; i < touches.length; i++) { sx += touches[i].x; sy += touches[i].y; }
    return { x: sx / touches.length, y: sy / touches.length };
  }

  function startStroke(e) {
    ensureSize();
    rectCache = null;
    var o = ptOf(e);
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    hideRing();
    activeId = e.pointerId;
    drawing = true;
    lastPr = o.pr;
    flatPress = false; prMin = 1; prMax = 0;
    live = { t: tool, c: curColor(), w: curWidth(), p: [], bb: null, flat: false };
    pushPoint(live, o.x, o.y, o.pr);
    scheduleLive();
  }

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    if (e.pointerType === 'pen') {
      if (penSeen === 0) { /* 第一次识别到手写笔：默认开启仅笔模式，防手掌误触 */
        pref.penOnly = true; savePref(); syncUI();
        toastMsg('检测到 Apple Pencil：已开启「仅手写笔」，手掌不会误画');
      }
      penSeen = Date.now();
      penId = e.pointerId;
      hideRing();
    }

    /* 双指平移：任何工具的第二个手指都进入翻页手势 */
    if (e.pointerType === 'touch') {
      touches.push({ id: e.pointerId, x: e.clientX, y: e.clientY });
      if (touches.length >= 2) {
        /* 笔正在手上（笔按着 / 刚抬起）：手掌压出来的两点不能当成翻页手势 */
        if (penRecent()) { touches.pop(); return; }
        if (drawing && live && live.p.length < 3 * 14) {   /* 刚起笔就变手势：丢掉这一笔 */
          live = null; drawing = false; activeId = -1; renderAll();
        } else if (drawing) { endStroke(); }
        panning = true; panLast = centroid(); panTick = 0;
        hideRing();
        e.preventDefault();
        return;
      }
      if (touchBlocked(e)) return;                        /* 手掌：直接不管 */
    }

    if (drawing && activeId !== e.pointerId) return;      /* 同一时刻只认一支笔 */
    e.preventDefault();
    ensureSize();                                        /* 位图尺寸先跟当前视口对齐 */
    rectCache = null;
    var o = ptOf(e);

    if (tool === 'pick') {
      var hit = hitTest(o.x, o.y);
      if (hit !== selected) { selected = hit; renderAll(); }
      if (selected) {
        drag = { s: selected, x: o.x, y: o.y, moved: false, prev: selected.p.slice() };
        try { cv.setPointerCapture(e.pointerId); } catch (err) {}
        activeId = e.pointerId;
      }
      return;
    }
    startStroke(e);
  }

  function onMove(e) {
    /* 悬停预览：笔没落下也能看到笔尖粗细（Apple Pencil 悬停 / 鼠标） */
    if (!drawing && !panning && !drag && (e.pointerType === 'pen' || e.pointerType === 'mouse')) {
      if (e.pointerType === 'pen') penSeen = Date.now();
      if (e.buttons === 0 && tool !== 'pick') {
        /* 环形指示器是 fixed 层，直接用视口坐标，别掺文档坐标 */
        showRing(e.clientX, e.clientY, Math.max(8, curWidth()));
        return;
      }
      hideRing();
    }

    if (panning) {
      for (var t = 0; t < touches.length; t++) {
        if (touches[t].id === e.pointerId) { touches[t].x = e.clientX; touches[t].y = e.clientY; }
      }
      if (touches.length >= 2 && panLast) {
        var c = centroid();
        panBy(c.x - panLast.x, c.y - panLast.y, c.x, c.y);
        panLast = c;
      }
      e.preventDefault();
      return;
    }

    if (drag) {
      var o = ptOf(e);
      var dx = o.x - drag.x, dy = o.y - drag.y;
      if (dx || dy) {
        drag.moved = true;
        translate(drag.s, dx, dy);
        drag.x = o.x; drag.y = o.y;
        scheduleDraw();
      }
      return;
    }
    if (!drawing || !live || e.pointerId !== activeId) return;
    e.preventDefault();
    var evs = null;
    if (e.getCoalescedEvents) { try { evs = e.getCoalescedEvents(); } catch (err) { evs = null; } }
    if (!evs || !evs.length) evs = [e];
    for (var i = 0; i < evs.length; i++) {
      var q = ptOf(evs[i]);
      if (live.t === 'pen') {
        if (flatPress) { q.pr = 1; }
        else { lastPr = lastPr * 0.65 + q.pr * 0.35; q.pr = lastPr; }
      }
      pushPoint(live, q.x, q.y, q.pr);
    }
    /* 判定这支笔到底有没有真压感。
       不报压感的设备按规范会固定回 0.5，若照单全收就会只画出一半粗细，
       所以一旦发现压力全程没有变化，就改按满压渲染，让线宽严格等于用户设定值。 */
    if (live.t === 'pen' && !flatPress && live.p.length >= 12 * 3 && (prMax - prMin) < 0.03) {
      flatPress = true;
      live.flat = true;
      for (var k = 2; k < live.p.length; k += 3) live.p[k] = 1;
      renderAll();
      if (!flatToasted) {
        flatToasted = true;
        toastMsg('这支笔不上报压感，已按你设定的粗细书写');
      }
    }
    scheduleLive();
  }

  function endStroke() {
    if (!drawing || !live) { drawing = false; activeId = -1; return; }
    if (live.p.length >= 3) live.p = Float32Array.from(live.p);
    if (live.p.length >= 3) {
      if (live.bb) {
        var pd = padOf(live) + 1;
        paintRect(live.bb.x0 - pd, live.bb.y0 - pd, live.bb.x1 + pd, live.bb.y1 + pd);
      }
      strokes.push(live);
      pushUndo({ t: 'add', s: live });
    }
    live = null; drawing = false; activeId = -1;
    syncUI();
  }
  function onUp(e) {
    if (e.pointerType === 'pen') penId = -1;
    if (e.pointerType === 'touch' && touches.length) {
      for (var i = touches.length - 1; i >= 0; i--) { if (touches[i].id === e.pointerId) touches.splice(i, 1); }
      if (touches.length < 2) { panning = false; panLast = null; }
    }
    if (panning) return;
    if (drag) {
      var d = drag; drag = null;
      if (d.moved) {
        pushUndo({ t: 'move', s: d.s, prev: d.prev, next: d.s.p.slice() });
        syncUI();
      }
      activeId = -1;
      return;
    }
    endStroke();
  }
  function onWheel(e) {
    var target = scrollHost(e.clientX, e.clientY);
    if (target) target.scrollTop += e.deltaY;
    else window.scrollBy(0, e.deltaY);
    readScroll(); scheduleDraw();
    e.preventDefault();
  }
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('pointerleave', function () { hideRing(); });
  cv.addEventListener('wheel', onWheel, { passive: false });
  /* 注意：不要同时监听 pointerrawupdate。
     它只有 Chromium 系浏览器有，而 pointermove 又会通过 getCoalescedEvents()
     把同一批原始样本原样重放一遍；两条都处理 = 每帧把这一批样本推两遍，
     新点落回上一批的起点，笔迹就来回折返成锯齿 —— 桌面端与安卓上表现为
     “斜向栅栏条纹”，而 Safari 不支持该事件所以 iPhone 一直正常。 */
  window.addEventListener('blur', function () { if (drawing) endStroke(); });
  window.addEventListener('contextmenu', function (e) { if (mode) e.preventDefault(); });

  /* ---------- 撤销 / 重做 / 清空 ---------- */
  function pushUndo(op) {
    undoStack.push(op);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
  }
  function doUndo() {
    var op = undoStack.pop();
    if (!op) return;
    if (op.t === 'add') {
      var i = strokes.lastIndexOf(op.s);
      if (i >= 0) strokes.splice(i, 1);
    } else if (op.t === 'del') {
      strokes.splice(Math.min(op.i, strokes.length), 0, op.s);
    } else if (op.t === 'move') {
      op.s.p = op.prev.slice(); computeBB(op.s); op.s._p2d = null;
    } else if (op.t === 'clear') {
      strokes = op.arr.slice();
    }
    redoStack.push(op);
    selected = null;
    renderAll(); syncUI();
  }
  function doRedo() {
    var op = redoStack.pop();
    if (!op) return;
    if (op.t === 'add') {
      strokes.push(op.s);
    } else if (op.t === 'move') {
      op.s.p = op.next.slice(); computeBB(op.s); op.s._p2d = null;
    } else if (op.t === 'clear') {
      op.arr = strokes.slice(); strokes = [];
    }
    undoStack.push(op);
    selected = null;
    renderAll(); syncUI();
  }

  /* ---------- 粗细 ---------- */
  function cfgOf(t) { return WCFG[t] || WCFG.pen; }
  function wToPos(w, t) {
    var c = cfgOf(t);
    var r = Math.log(Math.max(c.min, Math.min(c.max, w)) / c.min) / Math.log(c.max / c.min);
    return Math.round(r * 100);
  }
  function posToW(p, t) {
    var c = cfgOf(t);
    var r = Math.log(c.max / c.min);
    return c.min * Math.exp((p / 100) * r);
  }
  function fmtW(w) { return w >= 10 ? String(Math.round(w)) : (Math.round(w * 10) / 10).toFixed(1); }
  function setWidth(w, quiet) {
    var c = cfgOf(tool);
    w = Math.max(c.min, Math.min(c.max, w));
    if (tool === 'eraser') state.eraser.w = w; else activeState().w = w;
    wsl.value = wToPos(w, tool);
    syncWidthUI();
    if (!quiet) savePref();
  }
  function syncWidthUI() {
    var w = curWidth();
    wdot.style.width = Math.max(3, Math.min(26, w)) + 'px';
    wdot.style.height = wdot.style.width;
    wdot.style.color = (tool === 'eraser') ? (dark ? '#8b9bb1' : '#64748b') : activeState().c;
    wnum.textContent = fmtW(w) + 'px';
    /* 让「当前粗细」一眼可见：命中预设值时把那一颗点亮 */
    Array.prototype.forEach.call(presetsBox.children, function (b) {
      var v = Number(b.getAttribute('data-w'));
      b.classList.toggle('on', Math.abs(v - w) < 0.05);
    });
  }
  function buildPresets() {
    presetsBox.innerHTML = '';
    var arr = cfgOf(tool).presets;
    for (var i = 0; i < arr.length; i++) {
      (function (w) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = fmtW(w);
        b.title = '快捷粗细 ' + fmtW(w) + 'px';
        b.setAttribute('data-w', String(w));
        b.addEventListener('click', function () { setWidth(w); });
        presetsBox.appendChild(b);
      })(arr[i]);
    }
  }

  /* ---------- UI 同步 ---------- */
  function syncUI() {
    fab.className = 'fab' + (mode ? ' live' : '') + (strokes.length ? ' has' : '');
    fab.textContent = mode ? '退出演算' : '演算';
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
    penOnlyBtn.classList.toggle('on', !!pref.penOnly);
    penOnlyBtn.title = pref.penOnly ? '仅手写笔：已开启（忽略手指/手掌）' : '仅手写笔：已关闭（手指也能书写）';
    if (hintEl) {
      hintEl.textContent = penSeen
        ? '笔压已启用 · 双指翻页 · 退出即清空'
        : (isTouch() ? '双指翻页 · 退出即清空' : '滚轮翻页 · 退出即清空');
    }
    placeFab();
  }
  function isTouch() {
    try { return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0); } catch (e) { return false; }
  }
  function setMode(on) {
    var wasOn = mode;
    mode = !!on;
    if (!mode) {
      if (drawing) endStroke();
      panning = false; touches.length = 0; penId = -1;
      selected = null; drag = null;
      hideRing();
      if (wasOn && strokes.length) {
        strokes = [];
        undoStack.length = 0;
        redoStack.length = 0;
        toastMsg('已清空本页演算（不保存）');
      }
    }
    cv.classList.toggle('on', mode);
    cv.classList.toggle('pick', mode && tool === 'pick');
    bar.classList.toggle('show', mode);
    if (mode) {
      document.documentElement.style.overscrollBehavior = 'none';
      ensureSize();                                     /* 进演算前先对齐位图尺寸 */
    } else {
      document.documentElement.style.overscrollBehavior = '';
    }
    syncUI();
    renderAll();
  }
  function setTool(t) {
    if (drawing) endStroke();
    if (!TOOL_LABEL[t]) return;
    tool = t;
    pref.tool = t;
    selected = null;
    hideRing();
    Array.prototype.forEach.call(toolsBox.children, function (b) {
      if (b.getAttribute && b.getAttribute('data-tool')) b.classList.toggle('on', b.getAttribute('data-tool') === t);
    });
    cv.classList.toggle('pick', t === 'pick');
    wsl.value = wToPos(curWidth(), t);
    buildPresets();
    syncColors();
    syncWidthUI();
    renderAll();
    savePref();
  }
  function syncColors() {
    var c = (tool === 'pencil' || tool === 'marker') ? state[tool].c : (tool === 'eraser' ? null : state.pen.c);
    Array.prototype.forEach.call(colorsBox.children, function (b) {
      b.classList.toggle('on', c != null && b.getAttribute('data-c') === c);
    });
    syncWidthUI();
  }
  function placeFab() {
    if (mode) { fab.style.display = 'none'; return; }
    fab.style.display = '';
    var top = 12;
    try {
      var bars = document.querySelectorAll('.toolbar,.subnav');
      for (var i = 0; i < bars.length; i++) {
        var el = bars[i], st = window.getComputedStyle(el);
        if (st.position !== 'sticky' && st.position !== 'fixed') continue;
        var r = el.getBoundingClientRect();
        if (r.height > 0 && r.top < 6 && r.bottom + 10 > top) top = r.bottom + 10;
      }
    } catch (e) {}
    if (window.innerWidth <= 920 && top < 54) top = 54;
    fab.style.top = Math.round(top) + 'px';
  }

  /* ---------- 事件绑定 ---------- */
  fab.addEventListener('click', function () { setMode(!mode); });
  root.getElementById('hidenote').addEventListener('click', function () { setMode(false); });
  toolsBox.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'penonly') { togglePenOnly(); return; }
    setTool(b.getAttribute('data-tool'));
  });
  function togglePenOnly() {
    pref.penOnly = !pref.penOnly;
    savePref(); syncUI();
    toastMsg(pref.penOnly ? '已开启「仅手写笔」：手指/手掌不再留痕' : '已关闭「仅手写笔」：手指也能书写');
  }
  undoBtn.addEventListener('click', doUndo);
  redoBtn.addEventListener('click', doRedo);
  root.getElementById('clear').addEventListener('click', function () {
    if (!strokes.length) return;
    pushUndo({ t: 'clear', arr: strokes.slice() });
    strokes = [];
    selected = null;
    renderAll(); syncUI();
  });
  wsl.addEventListener('input', function () { setWidth(posToW(Number(wsl.value), tool)); });
  function buildColors() {
    colorsBox.innerHTML = '';
    var cs = palette(), ns = paletteName();
    cs.forEach(function (c, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sw';
      b.style.background = c;
      b.title = ns[i];
      b.setAttribute('data-c', c);
      b.addEventListener('click', function () {
        if (tool === 'pencil' || tool === 'marker') { state[tool].c = c; pref.color[tool] = i; }
        else { state.pen.c = c; if (tool !== 'eraser') pref.color.pen = i; }
        syncColors();
        savePref();
      });
      colorsBox.appendChild(b);
    });
    syncColors();
  }
  document.addEventListener('keydown', function (e) {
    if (!mode) return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var k = e.key;
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
    } else if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'Y')) {
      e.preventDefault(); doRedo();
    } else if (k === 'Escape') {
      setMode(false);
    } else if (k === '[' || k === ']') {
      e.preventDefault();
      var step = (tool === 'eraser' || tool === 'marker') ? 3 : 0.5;
      setWidth(curWidth() + (k === ']' ? step : -step));
    } else if (k === 'Delete' || k === 'Backspace') {
      if (selected) {
        e.preventDefault();
        var i = strokes.lastIndexOf(selected);
        if (i >= 0) {
          strokes.splice(i, 1);
          pushUndo({ t: 'del', s: selected, i: i });
          selected = null;
          renderAll(); syncUI();
        }
      }
    } else if (k >= '1' && k <= '5') {
      var idx = Number(k) - 1, c = palette()[idx];
      if (tool === 'pencil' || tool === 'marker') { state[tool].c = c; pref.color[tool] = idx; }
      else { state.pen.c = c; pref.color.pen = idx; }
      syncColors(); savePref();
    }
  });

  /* ---------- 滚动 / 尺寸 / 主题 / 生命周期 ---------- */
  function onScroll() {
    readScroll();
    scheduleDraw();
    if (!mode) placeFab();
  }
  window.addEventListener('scroll', onScroll, true);
  /* 捏合放大 / 收起地址栏都会改动态视口：缩放归 resize，平移只需作废坐标缓存 */
  if (window.visualViewport && window.visualViewport.addEventListener) {
    window.visualViewport.addEventListener('resize', function () { onResize(); });
    window.visualViewport.addEventListener('scroll', function () { rectCache = null; });
  }
  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resize();
      renderAll();
      placeFab();
    }, 80);
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  document.addEventListener('xz-theme-change', function () { applyTheme(); });
  function applyTheme() {
    var d = themeDark();
    if (d === dark) { host.setAttribute('data-theme', dark ? 'dark' : 'light'); return; }
    dark = d;
    host.setAttribute('data-theme', dark ? 'dark' : 'light');
    /* 换色板：只影响之后写的笔迹，以及“还是默认色”的那些工具 */
    var oldP = d ? PALETTE_LIGHT : PALETTE_DARK, newP = palette();
    ['pen', 'pencil', 'marker'].forEach(function (t) {
      var i = oldP.indexOf(state[t].c);
      if (i >= 0) state[t].c = newP[i];
    });
    buildColors();
    syncWidthUI();
    renderAll();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (rafLive) { cancelAnimationFrame(rafLive); rafLive = 0; }
      if (rafDraw) { cancelAnimationFrame(rafDraw); rafDraw = 0; }
      if (drawing) endStroke();
      panning = false; touches.length = 0;
    } else {
      resize(); renderAll();
    }
  });
  window.addEventListener('pagehide', function () {
    try { cv.width = 1; cv.height = 1; } catch (e) {}
  });
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) { resize(); renderAll(); placeFab(); }
  });

  /* ---------- 启动 ----------
     分两段：先让标识立刻出现在屏幕上；画布尺寸与首帧渲染放到下一帧。
     本层不读写任何笔迹：每次打开都是干净画布，退出即清空。 */
  var booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    loadOutline();                    /* 先把笔迹轮廓库拉起来（本地优先，失败走兜底） */
    readScroll();
    resize();
    buildColors();
    buildPresets();
    wsl.value = wToPos(curWidth(), tool);
    syncWidthUI();
    setTool(tool);
    syncUI();
    placeFab();
    renderAll();
  }
  window.__xzScratch = {
    count: function () { return strokes.length; },
    mode: function () { return mode; },
    ready: function () { return booted; },
    setMode: setMode,
    setTool: setTool,
    setWidth: function (w) { setWidth(Number(w) || 0); },
    getWidth: function () { return curWidth(); },
    /* 笔迹几何库是否已就绪（perfect-freehand）；没就绪时走恒定宽度的兜底渲染 */
    outline: function () { return !!PF; },
    penOnly: function (v) { if (typeof v === 'boolean') { pref.penOnly = v; savePref(); syncUI(); } return pref.penOnly; },
    clear: function () { strokes = []; undoStack = []; redoStack = []; renderAll(); syncUI(); }
  };

  syncUI();
  if (window.requestAnimationFrame) requestAnimationFrame(boot);
  else setTimeout(boot, 0);
})();
