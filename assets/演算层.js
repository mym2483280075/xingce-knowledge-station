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

   断墨（写着写着墨没了）专项修复 —— 详见各处的注释：
     i) 手掌抬起不再收笔：pointerup 只认「这一笔自己的 pointerId」。
        iPad 上手掌落下→抬起会补发一次 touch 的 pointerup，旧逻辑当场收笔，
        笔尖还在屏幕上，后面所有采样全被丢弃，表现就是字迹中途断掉。
     j) pointercancel 不再当抬笔：iOS 的手势抢占/手掌抑制/Scribble 会取消指针，
        此时笔尖通常还在屏上。现在只暂停（墨迹保留），同一支笔 900ms 内
        带相近落点回来就继续写同一笔，超时才落定。
     k) 收笔补点：pointerup 自身携带的位置（及其合批子样本）在收笔前补进这一笔，
        字尾不再被截断（excalidraw#9032 同类问题）。
     l) Scribble 兜底：在画布上对 touchstart/touchmove 调 preventDefault，
        绕开 WebKit bug 217430（Scribble 会把笔的指针事件吞掉 → 大量样本丢失）。
     m) 手写笔优先于手指：笔落下时，正在用手指/手掌画的那一笔让位，不再互相阻塞。
   ========================================================= */

/* ===================================================================
   给后续审阅者（人或 AI）的阅读约定 —— 改代码前先看这一段
   ---------------------------------------------------------------
   【需求】用户明确提出的要求 / 已确认的产品行为，改动不要违背
   【易错】最容易引入 bug 的地方：动它之前请把整段连同调用方一起读完
   【坑】  浏览器 / 平台差异陷阱（iPad、Safari、WebKit），注释里写了现象与规避法
   【性能】iPad 上的性能敏感点（每帧或每次采样都会走到）
   【接口】对外暴露、被其它文件依赖的名字与语义，改名等于破坏调用方
   【数据】localStorage 持久化格式，改字段必须兼容旧数据
   搜索这些标记即可快速定位所有需要小心的地方。
   ---------------------------------------------------------------
   文件结构（按出现顺序，可直接按名字跳读）：
     1) 常量与偏好：MAX_PTS / PT_MIN / RESUME_MS / WCFG / 调色板 / pref(PREF_KEY)
     2) 图标：ICON_PATHS（Lucide 原样引用，ISC 许可）
     3) Shadow DOM 的样式表与骨架：UI 全部在 shadow root 内，宿主 host 覆盖整个视口
     4) 尺寸与坐标：curDPR / sizeOf / fitCanvas / ensureSize / ptOf / readScroll
     5) 笔迹几何与渲染：perfect-freehand 轮廓、paintRect（局部重绘）、renderAll
     6) 采样：isReplay / decimate / pushPoint / 压感与无压感判定
     7) 交互：onDown / onMove / onUp / onCancel、断笔续写、双指平移、手掌抑制
     8) 撤销重做、粗细与颜色、UI 同步（syncUI / syncColors / syncWidthUI）
     9) 工具条停靠拖动 + 设置面板（颜色 + 粗细）：grip / applyDock / placeInsp
    10) 滚动·尺寸·主题·生命周期、启动 boot、对外接口 window.__xzScratch
   调试开关：网址加 ?xzdiag=1（或 localStorage['xz-ink-diag']='1'）打印书写统计；
   __xzScratch.diag() 取当前快照，__xzScratch.dock() 读/写停靠位。
   =================================================================== */
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
  /* 【易错】perfect-freehand 靠这个目录去动态 import：路径写错不会报错，
     只会静默退化到“整路径 + 恒定宽度描边”的兜底渲染（笔锋变钝），非常难发现。 */
  var ASSET_DIR = SELF ? SELF.replace(/[^\/]*$/, '') : '../assets/';

  /* 【坑】DPR 必须每次现取：浏览器缩放、窗口跨屏、iPad 捏合都会改变它。
     启动时读一次并缓存，会导致画布位图和显示尺寸对不上 —— 位图被拉伸显示，
     笔迹整体变大变粗（这正是“2 倍粗笔画”的根因）。上限 2 是省内存（3x 屏可省一半以上像素）。 */
  function curDPR() { return Math.min(window.devicePixelRatio || 1, 2); }
  /* 【性能】MAX_PTS：单笔点数上限，到顶会抽稀而不是停笔；PT_MIN：采样最小间距（CSS 像素），
     调小会让 iPad 上成倍的样本全部入账并参与每帧轮廓计算，性能直接受影响。
     【易错】MAX_UNDO 是撤销深度，调大意味着常驻更多 Float32Array 坐标。 */
  var MAX_PTS = 20000, PT_MIN = 0.35, MAX_UNDO = 120;
  /* 【需求】断笔续写窗口：pointercancel 之后，同一支笔在这个时间 / 距离内回来就算“同一笔”。
     这两个值是“书写连贯”和“两笔误合并”之间的平衡点：调大更黏、调小更容易断墨。 */
  var RESUME_MS = 900, RESUME_PX = 48;
  var FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
  /* 【数据】偏好存储键。字段：tool(工具) / penOnly(仅手写笔) / dock(停靠位) /
     color.pen|pencil|marker(色号 0-4) / w.*(各工具粗细)。
     这里只存设置、不存笔迹（【需求】退出即清空、不保存）。新增字段必须容忍旧数据里没有它。 */
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
  /* 【接口】优先问 主题.js 暴露的 window.__xzTheme.isDark()，拿不到就退回 html.xz-dark 类，
     再退回系统 prefers-color-scheme —— 三层兜底是为了本层被单独引入时也能正常工作。
     改这里前先确认 shadow root 内的 --ui-* 变量在两种主题下都还有足够对比度。 */
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
    var d = { tool: 'pen', penOnly: false, dock: 'bottom', color: { pen: 0, pencil: 0, marker: 4, eraser: -1 }, w: {} };
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(PREF_KEY) || 'null'); } catch (e) { raw = null; }
    if (raw && typeof raw === 'object') {
      if (TOOL_LABEL[raw.tool]) d.tool = raw.tool;
      if (typeof raw.penOnly === 'boolean') d.penOnly = raw.penOnly;
      if (raw.dock === 'top' || raw.dock === 'bottom' || raw.dock === 'left' || raw.dock === 'right') d.dock = raw.dock;
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
        tool: pref.tool, penOnly: pref.penOnly, dock: dock,
        color: pref.color,
        w: { pen: state.pen.w, pencil: state.pencil.w, marker: state.marker.w, eraser: state.eraser.w }
      }));
    } catch (e) {}
  }

  /* ---------- 图标 ----------
     取自 Lucide 图标库（github.com/lucide-icons/lucide，ISC 许可），
     path 数据原样引用，只统一字号/线宽以贴合本站的圆润风格。
     【接口】icon(name,size) 返回一段 <svg> 字符串，只认 24x24 viewBox 的描边型图标；
     换图标时不要改 viewBox 或填色方式，否则线宽与视觉重量会和其它按钮不一致。
     【易错】ICON_PATHS 必须定义在下面的 innerHTML 之前（骨架字符串里直接调用 icon()）。 */
  var ICON_PATHS = {
    pen: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    marker: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    eraser: '<path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21"/><path d="m5.082 11.09 8.828 8.828"/>',
    pick: '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>',
    trash: '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    /* 仅手写笔：触摸输入停用 */
    touchoff: '<path d="M12 20v-6"/><path d="M19.656 14H22"/><path d="M2 14h12"/><path d="m2 2 20 20"/><path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2"/><path d="M9.656 4H20a2 2 0 0 1 2 2v10.344"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    /* 拖动抓手：六点 */
    grip: '<circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="5" r="1" fill="currentColor"/><circle cx="9" cy="19" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="5" r="1" fill="currentColor"/><circle cx="15" cy="19" r="1" fill="currentColor"/>'
  };
  function icon(name, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) + '" fill="none" ' +
      'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true" focusable="false">' + (ICON_PATHS[name] || '') + '</svg>';
  }

  /* ---------- 构建隔离的 UI（Shadow DOM，不污染板块页样式） ---------- */
  /* 【易错】整个 UI 都活在 shadow root 里：取元素必须用 root.getElementById(...)，
     document.getElementById 永远找不到它们（改这一层时最容易犯的错）。
     【需求】host 固定覆盖全屏且 pointer-events:none，只有画布与工具条各自打开
     pointer-events —— 这样既能透过去看题目，也还能正常点击页面本身。 */
  var host = document.createElement('div');
  host.setAttribute('data-xz-scratch', '');
  host.setAttribute('data-theme', dark ? 'dark' : 'light');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
  var root = host.attachShadow({ mode: 'open' });

  root.innerHTML =
    '<style>' +
    '*{box-sizing:border-box}' +
    ':host{--ui-bg:rgba(255,255,255,.94);--ui-bg2:#f1f5f9;--ui-ink:#0f172a;--ui-ink2:#475569;--ui-ink3:#94a3b8;' +
      '--ui-line:rgba(15,23,42,.10);--ui-hair:rgba(15,23,42,.08);--ui-hi:#1d6fb8;--ui-chip:rgba(255,255,255,.72);--ui-warn:#c0392b;' +
      '--ui-tint:rgba(255,255,255,.62);--ui-glow:rgba(255,255,255,.9);--ui-sunk:rgba(15,23,42,.05);' +
      '--ui-shadow:0 0 0 .5px rgba(15,23,42,.06),0 16px 38px -22px rgba(15,23,42,.5),inset 0 1px 0 rgba(255,255,255,.9);--ui-r:18px}' +
    ':host([data-theme="dark"]){--ui-bg:rgba(20,29,45,.95);--ui-bg2:#22304a;--ui-ink:#e8eff9;--ui-ink2:#b6c3d4;' +
      '--ui-ink3:#8b9bb1;--ui-line:rgba(148,163,184,.20);--ui-hair:rgba(148,163,184,.16);--ui-hi:#7fb2ff;--ui-chip:rgba(255,255,255,.10);--ui-warn:#ff9b96;' +
      '--ui-tint:rgba(255,255,255,.07);--ui-glow:rgba(255,255,255,.10);--ui-sunk:rgba(255,255,255,.06);' +
      '--ui-shadow:0 0 0 .5px rgba(148,163,184,.16),0 18px 40px -22px rgba(0,0,0,.92),inset 0 1px 0 rgba(255,255,255,.08)}' +
    'canvas{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;' +
      'touch-action:none;overscroll-behavior:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-user-drag:none}' +
    'canvas.on{pointer-events:auto;cursor:crosshair}' +
    'canvas.pick{cursor:default}' +
    '.ring{position:absolute;left:0;top:0;border-radius:50%;border:1.5px solid currentColor;color:var(--ui-hi);' +
      'pointer-events:none;opacity:0;transform:translate(-50%,-50%);transition:opacity .14s;will-change:transform}' +
    '.ring.on{opacity:.85}' +
    '.fab{position:absolute;bottom:calc(16px + env(safe-area-inset-bottom,0px));right:16px;pointer-events:auto;border:0;border-radius:999px;padding:10px 16px;' +
      'font:600 13px/1 ' + FONT + ';color:#fff;background:rgba(29,111,184,.94);cursor:pointer;' +
      'box-shadow:0 8px 20px -10px rgba(15,23,42,.6);transition:background .18s,transform .14s;-webkit-tap-highlight-color:transparent}' +
    '.fab:hover{background:rgba(29,111,184,1)}' +
    '.fab:active{transform:scale(.97)}' +
    '.fab.live{background:rgba(100,116,139,.92)}' +
    ':host([data-theme="dark"]) .fab{background:rgba(58,110,178,.95)}' +
    '.fab.has::after{content:"";position:absolute;top:6px;right:9px;width:6px;height:6px;border-radius:50%;background:#f59e0b}' +
    '.bar{position:absolute;display:none;flex-wrap:wrap;justify-content:center;align-items:center;gap:2px 4px;' +
      'width:max-content;max-width:calc(100% - 16px);padding:6px 8px;border-radius:var(--ui-r);background:var(--ui-bg);pointer-events:auto;' +
      'box-shadow:var(--ui-shadow);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);' +
      'font:400 13px/1 ' + FONT + ';color:var(--ui-ink);-webkit-tap-highlight-color:transparent}' +
    '.bar.show{display:flex}' +
    /* 四个停靠位：上 / 下 / 左 / 右 四条边的中点。左/右为竖排，放不下会自动折成两列 */
    '.bar[data-dock="bottom"]{left:50%;bottom:calc(12px + env(safe-area-inset-bottom,0px));transform:translateX(-50%)}' +
    '.bar[data-dock="top"]{left:50%;top:calc(12px + env(safe-area-inset-top,0px));transform:translateX(-50%)}' +
    '.bar[data-dock="left"],.bar[data-dock="right"]{flex-direction:column;flex-wrap:wrap;align-content:center;' +
      'height:max-content;max-height:calc(100% - 26px);max-width:calc(100% - 26px);padding:6px}' +
    '.bar[data-dock="left"]{left:calc(12px + env(safe-area-inset-left,0px));top:50%;transform:translateY(-50%)}' +
    '.bar[data-dock="right"]{right:calc(12px + env(safe-area-inset-right,0px));top:50%;transform:translateY(-50%)}' +
    '.bar[data-dock="left"] .sep,.bar[data-dock="right"] .sep{width:22px;height:1px;margin:5px 0}' +
    '.bar[data-dock="left"] .grp,.bar[data-dock="right"] .grp{flex-direction:column}' +
    '.bar[data-dock="left"] .hint,.bar[data-dock="right"] .hint{display:none}' +
    '.bar.dragging{transform:none!important;cursor:grabbing;' +
      'box-shadow:0 26px 60px -26px rgba(15,23,42,.55),0 0 0 .5px rgba(15,23,42,.08),inset 0 1px 0 rgba(255,255,255,.9)}' +
    /* 抓手：拖它即可把工具条停靠到四边中点（也支持直接拖工具条的空白处） */
    '.grip{width:20px;height:40px;flex:none;display:grid;place-items:center;border:0;background:transparent;padding:0;' +
      'color:var(--ui-ink3);border-radius:9px;cursor:grab;touch-action:none;-webkit-tap-highlight-color:transparent;' +
      'transition:color .16s ease,background .16s ease}' +
    '.grip:hover{color:var(--ui-ink2);background:var(--ui-tint)}' +
    '.grip:focus-visible{outline:2px solid var(--ui-hi);outline-offset:2px}' +
    '.bar[data-dock="left"] .grip,.bar[data-dock="right"] .grip{width:40px;height:20px}' +
    '.bar[data-dock="left"] .grip svg,.bar[data-dock="right"] .grip svg{transform:rotate(90deg)}' +
    /* 拖动中在四条边中点显示落点提示，最近的那个高亮 */
    '.docks{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .16s ease}' +
    '.docks.on{opacity:1}' +
    '.dh{position:absolute;border-radius:999px;background:color-mix(in srgb,var(--ui-hi) 14%,transparent);' +
      'box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ui-hi) 26%,transparent);' +
      'transition:background .16s ease,box-shadow .16s ease}' +
    '.dh[data-dock="top"]{left:50%;top:calc(8px + env(safe-area-inset-top,0px));width:80px;height:7px;transform:translateX(-50%)}' +
    '.dh[data-dock="bottom"]{left:50%;bottom:calc(8px + env(safe-area-inset-bottom,0px));width:80px;height:7px;transform:translateX(-50%)}' +
    '.dh[data-dock="left"]{left:calc(8px + env(safe-area-inset-left,0px));top:50%;width:7px;height:80px;transform:translateY(-50%)}' +
    '.dh[data-dock="right"]{right:calc(8px + env(safe-area-inset-right,0px));top:50%;width:7px;height:80px;transform:translateY(-50%)}' +
    '.dh.on{background:color-mix(in srgb,var(--ui-hi) 42%,transparent);box-shadow:inset 0 0 0 1.5px var(--ui-hi)}' +
    '.grp{display:flex;align-items:center;gap:2px;flex:0 0 auto}' +
    '.sep{width:1px;height:22px;flex:none;background:var(--ui-hair);margin:0 5px;align-self:center}' +
    /* 图标按钮：等宽方块 + 极简高亮；选中态用当前墨色自染色，与板块配色语言一致 */
    '.tb{position:relative;width:40px;height:40px;flex:none;border:0;background:transparent;padding:0;display:grid;place-items:center;' +
      'border-radius:12px;color:var(--ui-ink2);cursor:pointer;-webkit-tap-highlight-color:transparent;' +
      'transition:background .16s ease,color .16s ease,transform .16s cubic-bezier(.3,.8,.4,1),box-shadow .16s ease}' +
    '.tb:hover{background:var(--ui-tint);color:var(--ui-ink)}' +
    '.tb:active{transform:scale(.94)}' +
    '.tb:focus-visible{outline:2px solid var(--ui-hi);outline-offset:2px}' +
    '.tb.on{color:var(--tc,var(--ui-hi));background:color-mix(in srgb,var(--tc,var(--ui-hi)) 13%,transparent);' +
      'box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tc,var(--ui-hi)) 22%,transparent),inset 0 1px 0 var(--ui-glow)}' +
    '.tb.tog.on{color:var(--ui-hi);background:color-mix(in srgb,var(--ui-hi) 13%,transparent);' +
      'box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ui-hi) 24%,transparent),inset 0 1px 0 var(--ui-glow)}' +
    '.tb.warn{color:var(--ui-warn)}' +
    '.tb.warn:hover{background:color-mix(in srgb,var(--ui-warn) 12%,transparent)}' +
    '.tb:disabled{opacity:.3;cursor:default}' +
    '.tb:disabled:hover{background:transparent;color:var(--ui-ink2)}' +
    /* 可展开提示：选中的工具下方一颗小点，再点一下即展开它的参数面板 */
    '.tb[data-more].on::after{content:"";position:absolute;left:50%;bottom:4px;width:4px;height:4px;border-radius:50%;' +
      'background:currentColor;opacity:.42;transform:translateX(-50%);transition:opacity .16s ease,transform .16s ease}' +
    '.tb[data-more].on.act::after{opacity:.95;transform:translateX(-50%) scale(1.25)}' +
    /* 参数面板：贴着被点的工具按钮向上弹出，带指向它的小箭头 */
    '.insp{position:absolute;visibility:hidden;opacity:0;pointer-events:none;width:max-content;min-width:236px;max-width:calc(100% - 20px);' +
      'padding:12px 14px 11px;border-radius:16px;background:var(--ui-bg);border:.5px solid var(--ui-hair);' +
      'box-shadow:var(--ui-shadow);-webkit-backdrop-filter:blur(26px) saturate(180%);backdrop-filter:blur(26px) saturate(180%);' +
      'transition:opacity .16s ease,transform .2s cubic-bezier(.3,.8,.4,1)}' +
    /* 面板出现在工具条的“外侧”，方向随停靠位翻转，小箭头始终指向被点的工具 */
    '.insp[data-side="up"]{transform:translateY(8px) scale(.96)}' +
    '.insp[data-side="down"]{transform:translateY(-8px) scale(.96)}' +
    '.insp[data-side="right"]{transform:translateX(-8px) scale(.96)}' +
    '.insp[data-side="left"]{transform:translateX(8px) scale(.96)}' +
    '.insp.on{visibility:visible;opacity:1;transform:none;pointer-events:auto}' +
    '.insp .caret{position:absolute;width:11px;height:11px;border-radius:2px;background:var(--ui-bg);transform:rotate(45deg)}' +
    '.insp[data-side="up"] .caret{bottom:-5.5px;margin-left:-5.5px;border-right:.5px solid var(--ui-hair);border-bottom:.5px solid var(--ui-hair)}' +
    '.insp[data-side="down"] .caret{top:-5.5px;margin-left:-5.5px;border-left:.5px solid var(--ui-hair);border-top:.5px solid var(--ui-hair)}' +
    '.insp[data-side="right"] .caret{left:-5.5px;margin-top:-5.5px;border-left:.5px solid var(--ui-hair);border-bottom:.5px solid var(--ui-hair)}' +
    '.insp[data-side="left"] .caret{right:-5.5px;margin-top:-5.5px;border-right:.5px solid var(--ui-hair);border-top:.5px solid var(--ui-hair)}' +
    '.sec+.sec{margin-top:11px;padding-top:11px;border-top:.5px solid var(--ui-hair)}' +
    '.secHd{display:flex;align-items:center;font:600 10.5px/1 ' + FONT + ';color:var(--ui-ink3);letter-spacing:.12em;margin-bottom:9px}' +
    '.secHd b{margin-left:auto;font-weight:600;color:var(--ui-ink2);letter-spacing:0;font-variant-numeric:tabular-nums}' +
    /* 色板：与侧栏板块色标同一套写法 —— 实心圆 + 径向遮罩，半透明、由内向外扩散 */
    '.sws{display:flex;align-items:center;gap:2px;margin:-2px -2px}' +
    '.sw{position:relative;width:38px;height:38px;flex:none;border:0;background:transparent;padding:0;display:grid;place-items:center;' +
      'border-radius:50%;cursor:pointer;-webkit-tap-highlight-color:transparent}' +
    '.swd{width:34px;height:34px;border-radius:50%;background:var(--c);will-change:transform;' +
      '-webkit-mask-image:radial-gradient(circle 13px at 50% 50%,#000 0%,rgba(0,0,0,.85) 30%,rgba(0,0,0,.40) 62%,rgba(0,0,0,.12) 86%,rgba(0,0,0,0) 100%);' +
      'mask-image:radial-gradient(circle 13px at 50% 50%,#000 0%,rgba(0,0,0,.85) 30%,rgba(0,0,0,.40) 62%,rgba(0,0,0,.12) 86%,rgba(0,0,0,0) 100%);' +
      'transition:transform .18s cubic-bezier(.3,.8,.4,1),-webkit-mask-image .18s ease,mask-image .18s ease}' +
    '.sw:hover .swd{transform:scale(1.06)}' +
    '.sw:focus-visible{outline:2px solid var(--ui-hi);outline-offset:1px}' +
    '.sw.on .swd{transform:scale(1.07);' +
      '-webkit-mask-image:radial-gradient(circle 14px at 50% 50%,#000 0%,rgba(0,0,0,.95) 34%,rgba(0,0,0,.48) 66%,rgba(0,0,0,.16) 88%,rgba(0,0,0,0) 100%);' +
      'mask-image:radial-gradient(circle 14px at 50% 50%,#000 0%,rgba(0,0,0,.95) 34%,rgba(0,0,0,.48) 66%,rgba(0,0,0,.16) 88%,rgba(0,0,0,0) 100%)}' +
    '.sw.on::after{content:"";position:absolute;inset:0;border-radius:50%;pointer-events:none;' +
      'box-shadow:0 0 0 1.5px var(--c),0 0 0 4px color-mix(in srgb,var(--c) 16%,transparent)}' +
    '.lb{color:var(--ui-ink3);font-size:11.5px;padding:0 4px;white-space:nowrap}' +
    /* 粗细：滑杆 + 当前粗细预览 + 四档快捷（用直径直接示意粗细） */
    '.wrow{display:flex;align-items:center;gap:9px}' +
    '.wsl{-webkit-appearance:none;appearance:none;flex:1 1 auto;min-width:104px;height:28px;margin:0;background:transparent;' +
      'color:var(--tc,var(--ui-hi));cursor:pointer}' +
    '.wsl::-webkit-slider-runnable-track{height:5px;border-radius:999px;' +
      'background:linear-gradient(90deg,color-mix(in srgb,currentColor 55%,transparent),color-mix(in srgb,currentColor 16%,transparent))}' +
    '.wsl::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;margin-top:-7.5px;border-radius:50%;border:0;' +
      'background:currentColor;box-shadow:0 1px 6px rgba(0,0,0,.35),0 0 0 3px var(--ui-bg)}' +
    '.wsl::-moz-range-track{height:5px;border-radius:999px;background:color-mix(in srgb,currentColor 32%,transparent)}' +
    '.wsl::-moz-range-thumb{width:18px;height:18px;border:0;border-radius:50%;background:currentColor}' +
    '.wpre{display:flex;align-items:center;gap:1px;flex:0 0 auto;color:var(--tc,var(--ui-hi))}' +
    '.wprev{width:28px;height:28px;flex:none;display:grid;place-items:center;border-radius:50%;background:var(--ui-sunk)}' +
    '.wdot{border-radius:50%;background:currentColor;flex:none}' +
    '.wpb{width:26px;height:26px;border:0;background:transparent;padding:0;display:grid;place-items:center;border-radius:50%;cursor:pointer}' +
    '.wpb i{display:block;border-radius:50%;background:currentColor;opacity:.42;' +
      'transition:opacity .16s ease,transform .16s cubic-bezier(.3,.8,.4,1)}' +
    '.wpb:hover i{opacity:.72}' +
    '.wpb.on i{opacity:1;transform:scale(1.12)}' +
    '.wpb:focus-visible{outline:2px solid var(--ui-hi);outline-offset:0}' +
    '.wnum{font:600 11.5px/1 ' + FONT + ';color:var(--ui-ink3);font-variant-numeric:tabular-nums}' +
    '.hint{color:var(--ui-ink3);font-size:11px;padding:0 4px;white-space:nowrap}' +
    '.toast{position:absolute;left:50%;bottom:calc(72px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);' +
      'background:rgba(15,23,42,.9);color:#fff;font:400 12.5px/1.35 ' + FONT + ';padding:9px 15px;border-radius:999px;' +
      'opacity:0;transition:opacity .22s;pointer-events:none;max-width:calc(100vw - 32px);text-align:center}' +
    ':host([data-theme="dark"]) .toast{background:rgba(226,232,240,.94);color:#101828}' +
    '.toast.on{opacity:1}' +
    '@media(max-width:900px){' +
      '.bar{padding:5px 6px;border-radius:20px;max-width:calc(100% - 12px)}' +
      '.bar[data-dock="bottom"]{bottom:calc(8px + env(safe-area-inset-bottom,0px))}' +
      '.bar[data-dock="top"]{top:calc(8px + env(safe-area-inset-top,0px))}' +
      '.bar[data-dock="left"],.bar[data-dock="right"]{padding:5px}' +
      '.tb{width:42px;height:42px;border-radius:13px}' +
      '.sep{margin:0 3px}' +
      '.insp{min-width:216px;padding:12px 13px 11px}' +
      '.sw{width:36px;height:36px}' +
      '.swd{width:32px;height:32px}' +
      '.wsl{height:34px;min-width:92px}' +
      '.hint{display:none}' +
      '.fab{bottom:calc(12px + env(safe-area-inset-bottom,0px));right:12px;padding:11px 17px;font-size:13.5px}' +
      '.toast{bottom:calc(120px + env(safe-area-inset-bottom,0px))}' +
    '}' +
    '@media(prefers-reduced-motion:reduce){.tb,.tb::after,.swd,.wpb i,.insp{transition:none!important}}' +
    '</style>' +
    '<canvas id="cv"></canvas>' +
    '<div class="ring" id="ring"></div>' +
    /* 拖动工具条时，四条边的中点会亮起落点提示（放在工具条下面，别挡住它） */
    '<div class="docks" id="docks">' +
      '<span class="dh" data-dock="top"></span>' +
      '<span class="dh" data-dock="bottom"></span>' +
      '<span class="dh" data-dock="left"></span>' +
      '<span class="dh" data-dock="right"></span>' +
    '</div>' +
    '<div class="bar" id="bar" data-dock="bottom" role="toolbar" aria-label="演算工具">' +
      '<button type="button" class="grip" id="grip" title="拖动我：可停靠到画面四条边的中点" aria-label="拖动工具条">' + icon('grip', 18) + '</button>' +
      '<div class="grp" id="tools" role="group" aria-label="画笔">' +
        '<button type="button" class="tb" data-tool="pen" data-more aria-pressed="false" title="钢笔 · 压感控制粗细（再点一次调颜色与粗细）">' + icon('pen') + '</button>' +
        '<button type="button" class="tb" data-tool="pencil" data-more aria-pressed="false" title="铅笔 · 等宽轻描（再点一次调颜色与粗细）">' + icon('pencil') + '</button>' +
        '<button type="button" class="tb" data-tool="marker" data-more aria-pressed="false" title="荧光笔 · 半透明宽笔（再点一次调颜色与粗细）">' + icon('marker') + '</button>' +
        '<button type="button" class="tb" data-tool="eraser" data-more aria-pressed="false" title="橡皮 · 擦掉笔迹（再点一次调大小）">' + icon('eraser') + '</button>' +
        '<button type="button" class="tb" data-tool="pick" aria-pressed="false" title="指针 · 点选、拖动、删除笔画">' + icon('pick') + '</button>' +
      '</div>' +
      '<span class="sep"></span>' +
      '<div class="grp" id="hist" role="group" aria-label="操作">' +
        '<button type="button" class="tb" id="undo" title="撤销（Ctrl/⌘ + Z）">' + icon('undo') + '</button>' +
        '<button type="button" class="tb" id="redo" title="重做（Ctrl/⌘ + Y）">' + icon('redo') + '</button>' +
        '<button type="button" class="tb warn" id="clear" title="清空本页演算（退出不保存）">' + icon('trash') + '</button>' +
        '<button type="button" class="tb tog" id="penonly" aria-pressed="false" title="仅手写笔：忽略手指与手掌">' + icon('touchoff') + '</button>' +
        '<button type="button" class="tb" id="hidenote" title="收起工具条，退出演算">' + icon('down') + '</button>' +
      '</div>' +
      '<span class="hint" id="hint"></span>' +
    '</div>' +
    /* 笔迹设置（颜色 + 粗细）：贴在当前工具按钮上方弹出，颜色相当于工具的下级面板 */
    '<div class="insp" id="insp" role="dialog" aria-label="笔迹设置">' +
      '<span class="caret" id="inspCaret"></span>' +
      '<div class="sec" id="colorSec">' +
        '<div class="secHd">颜色</div>' +
        '<div class="sws" id="colors" role="group" aria-label="笔迹颜色"></div>' +
      '</div>' +
      '<div class="sec">' +
        '<div class="secHd">粗细<b id="wnum">2.2px</b></div>' +
        '<div class="wrow">' +
          '<span class="wprev" id="wprev"><i class="wdot" id="wdot"></i></span>' +
          '<input type="range" class="wsl" id="wsl" min="0" max="100" step="1" value="50" aria-label="笔迹粗细">' +
          '<span id="wpresets" class="wpre"></span>' +
        '</div>' +
      '</div>' +
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
  var inspEl = root.getElementById('insp'), inspCaret = root.getElementById('inspCaret'), colorSec = root.getElementById('colorSec');
  var gripEl = root.getElementById('grip'), docksEl = root.getElementById('docks');
  var inspOpen = false, inspAnchor = null;
  /* 停靠位（上/下/左/右 四条边的中点）与拖动状态 */
  var dock = pref.dock || 'bottom', barDrag = null;
  var DOCK_NAME = { top: '上方', bottom: '下方', left: '左侧', right: '右侧' };
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

  /* 断笔续写：activeKind 记录“当前这一笔是哪类指针画的”，suspendAt 记录被取消的时刻 */
  var activeKind = '', suspendAt = 0, suspendTimer = 0, suspendId = -1;

  /* 诊断开关：地址栏加 ?xzdiag=1（或 localStorage['xz-ink-diag']='1'）后，
     只在控制台输出书写过程的统计，方便在 iPad 上核对是否还有断笔；不影响书写。 */
  var DIAG = (function () {
    try {
      return /(^|[?&])xzdiag=1/.test(location.search) || localStorage.getItem('xz-ink-diag') === '1';
    } catch (e) { return false; }
  })();
  var diagStat = { down: 0, up: 0, cancel: 0, resume: 0, maxPts: 0, coalesced: -1 };
  function diagLog(tag, extra) {
    if (!DIAG) return;
    try { console.log('[演算] ' + tag, extra === undefined ? '' : extra, diagStat); } catch (e) {}
  }

  /* ---------- 尺寸与坐标 ---------- */
  function readScroll() {
    scrollY = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }
  /* 【坑】画布位图必须严格等于「画布真实 CSS 盒子 × devicePixelRatio」。
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
  /* 【易错】fitCanvas 会重设 canvas.width/height，等于把整张画布清空。
     凡是调用它的路径，之后都必须补一次 renderAll()，否则已写的墨迹会当场消失。
     局部重绘（paintRect）与坐标缓存 rectCache 也都依赖这里的 W/H，改完要一起检查。 */
  function fitCanvas(s, d) {
    W = s.w; H = s.h;
    cv.width = Math.round(W * d);
    cv.height = Math.round(H * d);
    rectCache = null;
  }
  /* 【性能·内存】画布位图 = CSS 尺寸 × devicePixelRatio² × 4 字节：
     1440×900 的页面在 2x 屏上就是 20MB 上下，iPad Pro 更大。
     以前每次打开板块页都在 boot() 里直接分配（哪怕用户整页只读不写），
     现在改成「进演算才分配、退出即释放」，未用演算的页面这张位图根本不占内存。
     【易错】释放时必须把 W/H 归零并把 rectCache 置空，否则坐标换算会继续按旧尺寸算。 */
  function releaseCanvas() {
    if (cv.width > 1 || cv.height > 1) { cv.width = 1; cv.height = 1; }
    W = 1; H = 1; rectCache = null;
  }
  function resize() {
    if (!mode) { releaseCanvas(); return; }
    fitCanvas(sizeOf(cv), curDPR());
  }
  /* 【易错】落笔/拖动前自检：尺寸或 DPR 变了就地补正（内部会顺带 renderAll）。
     onDown 与 startStroke 都依赖它。以后新增任何“会改变画布盒子尺寸”的功能
     （新停靠位、折叠工具栏、动态改内边距等），都要确保落笔前仍能在这里修正一次，
     否则会重现“写上去位置整体偏移 / 笔迹过粗”这一类老问题。 */
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
  /* 【易错】所有指针坐标都从这里换算：clientX/Y 减画布盒子，再补 scrollY 变成文档坐标。
     rectCache 的失效点（resize / 页面滚动 / visualViewport 滚动 / 每次落笔）散落在本文件
     多处，少一处就会出现“笔迹整体偏移”，而且只在特定机型或缩放下才复现。
     新增任何会改变画布位置或页面滚动的功能时，务必在对应事件里把 rectCache 置空。 */
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
  /* 【易错】轮廓库加载：本地优先，失败再走两个 CDN；三条都失败会静默退化到恒定宽度描边
     （不报错、只是笔锋变钝）。加载完成后要重画一次，让已写的老笔迹也升级成轮廓渲染。
     GitHub Pages 对 .mjs 的 MIME 识别不可靠，所以内置副本用 .js 后缀（内容仍是 ESM）。 */
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
    /* 【易错】橡皮是真实的 destination-out 擦除：它会把“先于它绘制”的墨迹一起抹掉。
       重放顺序 = strokes 数组顺序，所以局部重绘、撤销/重做都必须保持顺序，
       否则同一张画在不同时刻重绘会擦出不同结果（看起来像“墨迹自己回来了”）。 */
    if (s.t === 'eraser') {
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
  /* 【易错】局部重绘：只重画给定矩形里的内容。
     —— 两个关键点，都是为了让边缘不出伪影：
        1) 矩形先向外取整到“设备像素边界”，clearRect 与 clip 都落在整像素上。
           小数坐标的 clearRect 会被抗锯齿，每帧在矩形四边留下一圈半透明浅痕，
           写字时一圈圈叠起来就是“栅栏条纹”（WebKit 上尤其明显）。
        2) 清理与裁剪在恒等变换（设备像素）下做，画笔迹时再切回文档坐标。
     改这里的取整方式、或改 hitBB 的 pad 余量，会立刻重现“栅栏条纹 / 鬼影”；
     另外别忘了末尾要补画 live（正在写的那一笔），否则书写中会出现半截笔迹。 */
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
  /* 【易错】整屏重绘：必须把正在写的那一笔（live）也画上，
     否则书写途中任何一次整屏重画都会把它擦掉（只留下后续脏矩形补的碎片）。
     另外它按 strokes 数组顺序重放，橡皮（destination-out）依赖这个顺序，不要随意重排。 */
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
  /* 【易错】反重放护栏：同一批原始样本被重复投喂时，新点会几乎精确落在前面某个已推过的点上。
     真人运笔不可能在几个采样点之内回到同一坐标，所以按“精确重合”丢点既安全又能挡住重复投递。
     回看窗口只留最近 3 点、判定半径收紧到 0.02px：iPad 上手写笔经 getCoalescedEvents()
     会给出 240Hz 的密集样本，窗口太大/半径太宽会把真人慢写的合法样本误判成重放丢点，
     反而在笔迹上留下断口。 */
  function isReplay(s, x, y) {
    var p = s.p, n = p.length / 3, k = 0;
    for (var i = n - 1; i >= 0 && k < 3; i--, k++) {
      var dx = x - p[i * 3], dy = y - p[i * 3 + 1];
      if (dx * dx + dy * dy < 0.0004) return true;      /* 0.02px 内视为同一个采样点 */
    }
    return false;
  }
  /* 【易错】点数到顶时不能“静默停笔”（那正是“写到这里墨就没了”的现象）：
     隔点抽稀一次，用一半分辨率换取继续记录，书写绝不中断。末点必须保留
     （抽稀把末点丢了，笔画尾巴会回缩一段）。 */
  function decimate(s) {
    var p = s.p, n = p.length / 3;
    if (n < 4) return;
    var q = [];
    for (var i = 0; i < n - 1; i += 2) q.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    q.push(p[(n - 1) * 3], p[(n - 1) * 3 + 1], p[(n - 1) * 3 + 2]);
    s.p = q; s._p2d = null;
  }
  /* 【易错】丢墨的唯一入口：点数上限（抽稀）、最小间距 PT_MIN、反重放三道具过滤都在这里。
     任何一道调得过严 = 断笔 / 丢点；调得过松（尤其关掉 isReplay）会让同一批合批样本被推两遍，
     笔迹来回折返成锯齿。改这里的阈值前，请连同上方的常量注释和 iPad 实机表现一起看。 */
  function pushPoint(s, x, y, pr) {
    var n = s.p.length;
    if (n >= MAX_PTS * 3) { decimate(s); n = s.p.length; }
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

  /* ---------- 笔尖悬停预览圈（Apple Pencil 悬停 / 鼠标） ----------
     【需求】未落笔也能看到笔尖粗细：iPad Pro M2+ / iPadOS 16.4+ 支持悬停；桌面端鼠标同理。
     用的是 fixed 层坐标（clientX/Y），不要掺文档坐标，否则滚动后预览圈会飘。 */
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

  /* 【需求】手写笔是否“正在使用中”（笔尖按着，或刚抬起不到 0.8 秒）。
     这个 800ms 是手掌抑制的核心参数：调小会让手掌在抬笔间隙里开始留痕，调大则会让
     用户放下笔后 0.8 秒内用不了手指。penSeen 由 onDown / onMove 的悬停分支持续刷新。 */
  function penRecent() {
    return penId !== -1 || (penSeen !== 0 && (Date.now() - penSeen) < 800);
  }

  /* 【需求】触摸是否应当被忽略（手掌抑制）。三条规则：
     指针模式下手指是刻意操作、不拦；「仅手写笔」开着时一律拦；笔正在手上时拦。
     改这里的判断等于改“手掌会不会误画”，务必在 iPad 上实测（含仅笔开关两种状态）。 */
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

  /* 【易错】落笔初始化：必须先 ensureSize()（内部可能重绘并改 W/H）、再清 rectCache、
     最后才取坐标。顺序颠倒会让首点落在旧坐标系里（表现为整笔起点偏移）。
     另外第一行的 `if (live) endStroke()` 不能删：它负责把“断笔待续”挂着的那一笔先落定，
     删掉就等于丢墨（上一笔会被新的一笔覆盖掉）。 */
  function startStroke(e) {
    ensureSize();
    rectCache = null;
    var o = ptOf(e);
    if (live) endStroke();          /* 上一笔还挂在“断笔待续”状态：先落定，绝不丢墨 */
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    hideRing();
    activeId = e.pointerId;
    activeKind = e.pointerType || '';
    drawing = true;
    suspendAt = 0;
    lastPr = o.pr;
    flatPress = false; prMin = 1; prMax = 0;
    live = { t: tool, c: curColor(), w: curWidth(), p: [], bb: null, flat: false };
    pushPoint(live, o.x, o.y, o.pr);
    scheduleLive();
    diagStat.down++;
  }

  /* ---------- 断笔续写（【需求】用户反馈的“断墨”专项修复，勿回退） ----------
     iOS/iPadOS 会在手掌抑制、Scribble、屏幕边缘手势、系统弹层等情况下把手写笔的
     指针“取消”（pointercancel），此时笔尖往往还按在屏幕上。旧代码把它当抬笔处理，
     这一笔当场落定，之后所有 pointermove 都被 `!drawing` 拦掉 —— 用户看到的就是
     “写着写着墨没了”。现在的做法：取消只“暂停”，同一支笔在 RESUME_MS 内带着
     相近落点回来就继续写同一笔；超时或下一笔开始时再落定。
     【易错】这里的取舍是“连贯”与“误合并”：窗口越大越不容易断墨，但也更容易把
     用户真的分两次写的两笔粘成一笔（撤销时会一起消失）。改 RESUME_MS / RESUME_PX 前
     请先用 __xzScratch.diag() 在 iPad 上确认 cancel/resume 的实际计数。 */
  function resumeNear(o) {
    if (!live || live.p.length < 3) return false;
    var n = live.p.length / 3;
    var dx = o.x - live.p[(n - 1) * 3], dy = o.y - live.p[(n - 1) * 3 + 1];
    return dx * dx + dy * dy <= RESUME_PX * RESUME_PX;
  }
  function armSuspendTimer() {
    if (suspendTimer) clearTimeout(suspendTimer);
    suspendTimer = setTimeout(function () {
      suspendTimer = 0;
      if (!drawing && live) endStroke();
    }, RESUME_MS);
  }
  function resumeStroke(e, o) {
    if (suspendTimer) { clearTimeout(suspendTimer); suspendTimer = 0; }
    suspendAt = 0; suspendId = -1;
    drawing = true; activeId = e.pointerId; activeKind = e.pointerType || '';
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    var pr = o.pr;
    if (live.t === 'pen') {
      if (flatPress) pr = 1;
      else { lastPr = lastPr * 0.65 + pr * 0.35; pr = lastPr; }
    }
    pushPoint(live, o.x, o.y, pr);
    diagStat.resume++;
    diagLog('续写同一笔', live.p.length / 3 + ' 点');
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

    /* 【需求】双指平移：任何工具的第二个手指都进入翻页手势（本层自己实现滚动，
       所以不依赖浏览器默认行为，这也是上面能在 touch 上 preventDefault 的前提）。
       【易错】刚起笔就变手势时会把这一笔丢掉（live.p.length < 3*14 的判定）：
       这个阈值决定“多短的一笔会被当成误触舍弃”，调大容易误删用户真的短横线。 */
    if (e.pointerType === 'touch') {
      touches.push({ id: e.pointerId, x: e.clientX, y: e.clientY });
      if (touches.length >= 2) {
        /* 笔正在手上（笔按着 / 刚抬起）：手掌压出来的两点不能当成翻页手势 */
        if (penRecent()) { touches.pop(); return; }
        if (drawing && live && live.p.length < 3 * 14) {   /* 刚起笔就变手势：丢掉这一笔 */
          live = null; drawing = false; activeId = -1; activeKind = ''; renderAll();
        } else if (live) { endStroke(); }
        panning = true; panLast = centroid(); panTick = 0;
        hideRing();
        e.preventDefault();
        return;
      }
      if (touchBlocked(e)) return;                        /* 手掌：直接不管 */
    }

    /* 同一时刻只认一支笔；并且「手写笔 > 手指」：
       笔落下时，正在用手指/手掌画的这一笔让位（几乎都是手掌误触），
       否则笔的这次落点会被直接忽略，整笔画不出来。 */
    if (drawing && activeId !== e.pointerId) {
      if (e.pointerType === 'pen' && activeKind === 'touch') {
        if (live && live.p.length >= 6 * 3) endStroke();
        else { live = null; drawing = false; activeId = -1; activeKind = ''; renderAll(); }
      } else {
        return;
      }
    }
    e.preventDefault();
    ensureSize();                                        /* 位图尺寸先跟当前视口对齐 */
    rectCache = null;
    var o = ptOf(e);

    /* 断笔续写：同一支笔在待续窗口内带相近落点回来，接着上一笔写 */
    if (live && !drawing && tool !== 'pick' && e.pointerType === 'pen' && suspendAt &&
        (Date.now() - suspendAt) < RESUME_MS && resumeNear(o)) {
      resumeStroke(e, o);
      return;
    }

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
    /* 被取消的指针有时还会继续送 pointermove（WebKit 的手势仲裁就是这样，
       笔尖从没离开屏幕）：这种情况下绝不能把墨丢掉，直接接着这一笔写。
       放在悬停预览之前判断，否则会被“未落笔就 return”的分支挡掉。 */
    if (!drawing && live && suspendId !== -1 && e.pointerId === suspendId &&
        e.buttons !== 0 && suspendAt && (Date.now() - suspendAt) < RESUME_MS) {
      resumeStroke(e, ptOf(e));
    }
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
    /* 被取消的指针有时还会继续送 pointermove（WebKit 的手势仲裁就是这样，
       笔尖从没离开屏幕）：这种情况下绝不能把墨丢掉，直接接着这一笔写。 */
    if (!drawing && live && suspendId !== -1 && e.pointerId === suspendId && suspendAt &&
        (Date.now() - suspendAt) < RESUME_MS) {
      resumeStroke(e, ptOf(e));
    }
    if (!drawing || !live || e.pointerId !== activeId) return;
    e.preventDefault();
    var evs = null;
    if (e.getCoalescedEvents) { try { evs = e.getCoalescedEvents(); } catch (err) { evs = null; } }
    if (!evs || !evs.length) evs = [e];
    if (DIAG) diagStat.coalesced = e.getCoalescedEvents ? 1 : 0;
    for (var i = 0; i < evs.length; i++) {
      var q = ptOf(evs[i]);
      if (live.t === 'pen') {
        if (flatPress) { q.pr = 1; }
        else { lastPr = lastPr * 0.65 + q.pr * 0.35; q.pr = lastPr; }
      }
      pushPoint(live, q.x, q.y, q.pr);
    }
    if (DIAG) diagStat.maxPts = Math.max(diagStat.maxPts, live.p.length / 3);
    /* 【坑】【需求】判定这支笔到底有没有真压感。
       不报压感的设备按规范会固定回 0.5，若照单全收就会只画出一半粗细，
       所以一旦发现压力全程没有变化，就改按满压渲染，让线宽严格等于用户设定值
       （用户看到的提示语“这支笔不上报压感，已按你设定的粗细书写”就对应这段逻辑，
        改行为时记得同步改文案）。阈值 0.03 / 12 点是实机调出来的，别凭感觉调。 */
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

  /* 落定当前这一笔：把 live 变成正式笔画并重画它占过的区域。
     注意「断笔待续」状态下 drawing 已经是 false，但 live 还在，
     这里必须照样落定（旧实现会因为 !drawing 直接返回，把这一笔整个丢掉）。
     另外顺序不能反：必须先重画（此时 live 仍指向这一笔，paintRect 会把它一起画上）
     再置空 live —— 反过来的话局部重绘只画已提交的笔画，刚写完的墨色会被当场擦掉。 */
  function commitStroke() {
    if (!live) { drawing = false; activeId = -1; activeKind = ''; suspendAt = 0; suspendId = -1; return false; }
    var s = live;
    var had = s.p.length >= 3;
    if (had) {
      s.p = Float32Array.from(s.p);
      computeBB(s);
      if (s.bb) {
        var pd = padOf(s) + 1;
        paintRect(s.bb.x0 - pd, s.bb.y0 - pd, s.bb.x1 + pd, s.bb.y1 + pd);
      }
    }
    live = null;
    drawing = false; activeId = -1; activeKind = ''; suspendAt = 0; suspendId = -1;
    if (suspendTimer) { clearTimeout(suspendTimer); suspendTimer = 0; }
    if (!had) return false;
    strokes.push(s);
    pushUndo({ t: 'add', s: s });
    return true;
  }
  function endStroke() {
    commitStroke();
    syncUI();
  }
  /* 收笔补点：pointerup 自带的位置（以及它合并掉的子样本）常常比最后一个
     pointermove 更靠后 —— iPad + 手写笔尤其明显，合批样本只覆盖到上一帧，
     抬笔瞬间的最后一段会丢，写出来就是“字尾少一截”。这里先补点再落定。 */
  function feedUpSamples(e) {
    if (!drawing || !live || e.pointerId !== activeId) return;
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
  }
  function onUp(e) {
    diagStat.up++;
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
    /* 【需求】【易错】关键：只有「这一笔自己的指针」抬起才算收笔。
       iPad 上手写笔在写、手掌落上再抬起，浏览器会给手掌补发一次 touch 的
       pointerup（pointerId 完全不同）。旧代码不加判断就 endStroke()，
       笔尖还在屏幕上，这一笔却被当场收掉，后面的采样全被丢弃 —— 断墨。
       这里的 pointerId 判断是断墨修复的第一道防线，不要为了“简化”而删掉。 */
    if (!drawing || !live) return;
    if (e.pointerId !== activeId) {
      diagLog('忽略非本笔的抬起', (e.pointerType || '') + '#' + e.pointerId + ' 当前#' + activeId);
      return;
    }
    feedUpSamples(e);
    endStroke();
  }
  /* 【需求】pointercancel 只“暂停”，不落定、不丢点：iOS 的 Scribble / 手掌抑制 /
     边缘手势 / 系统弹层都会取消指针，而笔尖往往还在屏上。
     注意这里刻意**不**调用 endStroke()，也不要顺手把 live 置空 —— 那是回退到旧行为。 */
  function onCancel(e) {
    diagStat.cancel++;
    diagLog('pointercancel', (e.pointerType || '') + '#' + e.pointerId);
    if (e.pointerType === 'pen') {
      penId = -1;
      penSeen = Date.now();          /* 800ms 内仍视为“笔在手”，手掌继续被抑制 */
    }
    if (e.pointerType === 'touch' && touches.length) {
      for (var i = touches.length - 1; i >= 0; i--) { if (touches[i].id === e.pointerId) touches.splice(i, 1); }
      if (touches.length < 2) { panning = false; panLast = null; }
    }
    if (drag) { drag = null; activeId = -1; if (panning) { panning = false; panLast = null; } return; }
    if (drawing && live && e.pointerId === activeId) {
      drawing = false; activeId = -1;      /* 只暂停：live 与 activeKind 都留着 */
      suspendAt = Date.now(); suspendId = e.pointerId;
      armSuspendTimer();
      scheduleLive();                      /* 补画一遍，别让最后一次局部重绘被取消吞掉 */
      return;
    }
    if (panning) { panning = false; panLast = null; }
  }
  /* 【需求】滚轮翻页：演算模式下画布盖住了页面，滚轮事件要转交给底下的可滚动容器，
     否则桌面上会“滚不动”。scrollHost 用一次 elementFromPoint 找最近的可滚动祖先。 */
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
  cv.addEventListener('pointercancel', onCancel);      /* 取消 ≠ 抬笔，见 onCancel 注释 */
  cv.addEventListener('pointerleave', function () { hideRing(); });
  cv.addEventListener('wheel', onWheel, { passive: false });
  /* 【坑】【需求】iPadOS 14 起 Safari 的 Scribble / 手掌识别会在书写过程中把指针事件吞掉
     （WebKit bug 217430：一笔里大量样本根本不派发，用户看到的就是“断墨”；
     Apple 开发者论坛给出的绕法就是在 touchmove 上 preventDefault）。
     这里在画布上拦住触摸的默认行为，样本才会老老实实全部交给我们；
     本层的双指平移是自己实现的（不依赖浏览器滚动），所以不会丢翻页能力。
     【易错】这两个监听必须保持 {passive:false}：写成 passive 后 preventDefault 会失效，
     断墨会原样回来，而且不会有任何报错提示。 */
  function blockTouch(e) { if (mode && e.cancelable) e.preventDefault(); }
  cv.addEventListener('touchstart', blockTouch, { passive: false });
  cv.addEventListener('touchmove', blockTouch, { passive: false });
  /* 【易错】触摸记账的清账兜底：touches 只在画布（cv）上收 pointerup。
     手指/手掌抬起的落点若压在工具条等“画布之外、但属于本层”的元素上，
     cv 收不到那次 pointerup，这条记录就会一直留在 touches 里：
     表现为双指平移在只剩一指时还在继续滚、以及质心被一个早已抬起的手指带偏。
     这里在 window 的捕获阶段补一道清账，只把已抬起的指针移出 touches，
     幂等且与 cv 的收笔逻辑互不干扰（cv 里那份照旧负责落定笔画）。 */
  function pruneTouch(e) {
    if (!e || e.pointerType !== 'touch' || !touches.length) return;
    for (var i = touches.length - 1; i >= 0; i--) { if (touches[i].id === e.pointerId) touches.splice(i, 1); }
    if (touches.length < 2) { panning = false; panLast = null; panTick = 0; }
  }
  window.addEventListener('pointerup', pruneTouch, true);
  window.addEventListener('pointercancel', pruneTouch, true);
  /* 【易错】注意：不要同时监听 pointerrawupdate。
     它只有 Chromium 系浏览器有，而 pointermove 又会通过 getCoalescedEvents()
     把同一批原始样本原样重放一遍；两条都处理 = 每帧把这一批样本推两遍，
     新点落回上一批的起点，笔迹就来回折返成锯齿 —— 桌面端与安卓上表现为
     “斜向栅栏条纹”，而 Safari 不支持该事件所以 iPhone 一直正常。
     （WebKit 从 Safari 18.2 起才补上 getCoalescedEvents()：更早的 iPadOS 上
      pointermove 里没有合批子样本，只能靠上面 touch 这条兜底尽量别被吞掉。） */
  window.addEventListener('blur', function () { if (live) endStroke(); });
  window.addEventListener('contextmenu', function (e) { if (mode) e.preventDefault(); });

  /* ---------- 撤销 / 重做 / 清空 ----------
     【易错】栈里存的是“操作 + 笔画引用”，不是位图快照（省内存）。
     于是 undo/redo 必须保证 strokes 与两个栈始终一致：
       add  → 追加/移除同一个对象引用（不要克隆，克隆会让 lastIndexOf 失效）
       del  → 记住插入位置 op.i，撤销时插回原位置，否则橡皮的擦除顺序会被打乱
       move → 存 prev / next 两份坐标快照，撤销后要 computeBB 并清掉 _p2d 轮廓缓存
     改任何一支分支后，按 Ctrl+Z/Y 连续操作一遍并确认画面与 strokes 完全同步。 */
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
    } else if (op.t === 'del') {
      /* 【易错】撤销删除（Ctrl+Z）之后必须还能重做回来：这里按引用移除同一支笔，
         不能用 op.i 下标（撤销插入位置之后 strokes 可能又变了）。
         漏掉这一支会让“选中→删除→撤销→重做”在重做这一步静默无反应。 */
      var j = strokes.lastIndexOf(op.s);
      if (j >= 0) strokes.splice(j, 1);
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
  /* 【易错】粗细滑杆用对数映射（wToPos / posToW）：这样细笔段的手感才够细腻。
     两者必须严格互逆，改映射公式要同时改另一个，否则拖到某个位置会来回跳。
     区间来自 WCFG[tool]，各工具不同（钢笔 0.6~14，荧光笔 8~48 等）。 */
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
  /* 【易错】粗细的对外入口：一次调用要同时更新 state、滑杆位置（wToPos）和预览 UI，
     漏一处就会出现“滑杆和实际线宽不一致”。quiet=true 是拖动滑杆时的高频调用
     （不写 localStorage，避免每帧 IO）。越界值会被 WCFG 区间静默钳制，不报错。 */
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
  /* 四档快捷粗细：直接用圆的直径示意粗细，比数字更直观 */
  function buildPresets() {
    presetsBox.innerHTML = '';
    var arr = cfgOf(tool).presets;
    arr.forEach(function (w) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'wpb';
      b.title = '快捷粗细 ' + fmtW(w) + 'px';
      b.setAttribute('data-w', String(w));
      b.setAttribute('aria-label', '粗细 ' + fmtW(w) + 'px');
      var i = document.createElement('i');
      /* 圆点直径按“该工具粗细区间”归一化到 5~18px：
         直接画 w 像素在钢笔上会全都挤成一样大（1.2 与 8 几乎看不出差别）。 */
      var c = cfgOf(tool);
      var d = Math.round(5 + 13 * Math.max(0, Math.min(1, (w - c.min) / (c.max - c.min))));
      i.style.width = d + 'px';
      i.style.height = d + 'px';
      b.appendChild(i);
      b.addEventListener('click', function () { setWidth(w); });
      presetsBox.appendChild(b);
    });
  }

  /* ---------- UI 同步 ---------- */
  function syncUI() {
    fab.className = 'fab' + (mode ? ' live' : '') + (strokes.length ? ' has' : '');
    fab.textContent = mode ? '退出演算' : '演算';
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
    penOnlyBtn.classList.toggle('on', !!pref.penOnly);
    penOnlyBtn.setAttribute('aria-pressed', pref.penOnly ? 'true' : 'false');
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
  /* 【需求】「演算」模式的开关：进入后画布接管单指、工具条出现；退出时按用户要求
     **清空本页演算且不保存**（只保留设置偏好）。所以这里会清 strokes 和两个栈。
     【易错】退出前必须先把正在写的/待续的那一笔落定（if (live) endStroke()），
     否则下一次进入时 live 还挂着上一页的坐标，会出现莫名其妙的“幽灵笔画”。 */
  function setMode(on) {
    var wasOn = mode;
    mode = !!on;
    if (!mode) {
      closeInsp();
      if (live) endStroke();
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
      releaseCanvas();                                  /* 退出即释放位图（见 releaseCanvas 注释） */
    }
    syncUI();
    renderAll();
  }
  function setTool(t) {
    if (live) endStroke();
    closeInsp();
    if (!TOOL_LABEL[t]) return;
    tool = t;
    pref.tool = t;
    selected = null;
    hideRing();
    Array.prototype.forEach.call(toolsBox.children, function (b) {
      if (b.getAttribute && b.getAttribute('data-tool')) {
        var on = b.getAttribute('data-tool') === t;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
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
      var on = c != null && b.getAttribute('data-c') === c;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    syncAccent();
    syncWidthUI();
  }
  /* 【需求】当前墨色 = 整条工具条的点缀色：选中的工具按钮、滑杆、粗细预览都跟着它走。
     颜色一变就要重新调用；橡皮没有墨色，用中性灰，避免工具条突然变成上一支笔的红色。 */
  function syncAccent() {
    var c = (tool === 'eraser') ? (dark ? '#8b9bb1' : '#64748b') : activeState().c;
    if (c) bar.style.setProperty('--tc', c);
  }
  function placeFab() {
    if (mode) { fab.style.display = 'none'; return; }
    fab.style.display = '';
    /* 【需求】演算按钮固定在右下角（CSS 里给 bottom/right）。
       原来贴在右上角并按吸顶条动态让位：但右上角正是页头标题与元信息胶囊的位置，
       iPad 阅读时一直压着正文，而且和顶栏的计时/显示模式按钮视觉打架。
       停靠工具条只在演算模式出现，本按钮在演算模式下会被隐藏，两者不会重叠。 */
    fab.style.top = 'auto';
  }

  /* ---------- 笔迹设置面板（颜色 + 粗细） ----------
     交互沿用成熟画布应用的做法（Excalidraw 的 ToolIcon 子面板、tldraw 的样式面板）：
     工具按钮点一下切换工具，再点一下才展开这个工具自己的参数面板；
     面板贴着该按钮向上弹出，带一支指向它的小箭头，箭头位置同时作为缩放动画的原点。 */
  /* 【易错】面板定位：按停靠位决定弹在工具条的哪一侧，再用按钮中心对齐 + 边界钳制。
     三个坑：①必须以 host 盒子为边界（页面有滚动条时 innerWidth 会大十几像素，面板会贴边不准）；
     ②iw/ih 要在设置 data-side 之后量；③外侧放不下时退回上下弹出，否则面板会横着顶出屏幕。
     改完请在四个停靠位各点一次工具图标，确认箭头仍指向按钮、面板不越界。 */
  function placeInsp() {
    if (!inspOpen || !inspAnchor) return;
    var br = bar.getBoundingClientRect(), ar = inspAnchor.getBoundingClientRect();
    /* 以画布层自己的盒子为边界（它才是定位参照），不用 window.innerWidth：
       页面有滚动条时两者能差十几个像素，面板会贴边贴不准 */
    var hb = host.getBoundingClientRect();
    var vw = Math.round(hb.width) || window.innerWidth, vh = Math.round(hb.height) || window.innerHeight, gap = 10;
    /* 面板永远出现在工具条的“外侧”：下停靠→上方，上停靠→下方，左停靠→右侧，右停靠→左侧 */
    var side = dock === 'top' ? 'down' : (dock === 'left' ? 'right' : (dock === 'right' ? 'left' : 'up'));
    inspEl.style.left = inspEl.style.right = inspEl.style.top = inspEl.style.bottom = 'auto';
    var iw = inspEl.offsetWidth || 236, ih = inspEl.offsetHeight || 150;
    /* 外侧放不下就退回上下弹出，避免面板横着顶出屏幕 */
    if (side === 'right' && br.right + gap + iw + 8 > vw) side = 'up';
    else if (side === 'left' && br.left - gap - iw - 8 < 0) side = 'up';
    inspEl.dataset.side = side;
    if (side === 'up' || side === 'down') {
      var left = Math.max(8, Math.min(Math.max(8, vw - iw - 8), (ar.left + ar.width / 2) - iw / 2));
      inspEl.style.left = Math.round(left) + 'px';
      if (side === 'up') inspEl.style.bottom = Math.round(vh - br.top + gap) + 'px';
      else inspEl.style.top = Math.round(br.bottom + gap) + 'px';
      var rx = Math.max(15, Math.min(iw - 15, (ar.left + ar.width / 2) - left));
      inspCaret.style.left = Math.round(rx) + 'px';
      inspCaret.style.top = '';
      inspEl.style.transformOrigin = Math.round(rx) + 'px ' + (side === 'up' ? '100%' : '0%');
    } else {
      var top = Math.max(8, Math.min(Math.max(8, vh - ih - 8), (ar.top + ar.height / 2) - ih / 2));
      inspEl.style.top = Math.round(top) + 'px';
      if (side === 'right') inspEl.style.left = Math.round(br.right + gap) + 'px';
      else inspEl.style.right = Math.round(vw - br.left + gap) + 'px';
      var ry = Math.max(15, Math.min(ih - 15, (ar.top + ar.height / 2) - top));
      inspCaret.style.top = Math.round(ry) + 'px';
      inspCaret.style.left = '';
      inspEl.style.transformOrigin = (side === 'right' ? '0% ' : '100% ') + Math.round(ry) + 'px';
    }
  }
  function openInsp(anchor) {
    if (anchor) inspAnchor = anchor;
    if (!inspAnchor) return;
    inspOpen = true;
    if (colorSec) colorSec.style.display = (tool === 'eraser') ? 'none' : '';   /* 橡皮没有颜色 */
    inspEl.classList.add('on');
    inspAnchor.classList.add('act');
    inspAnchor.setAttribute('aria-expanded', 'true');
    placeInsp();
  }
  function closeInsp() {
    if (!inspOpen) return;
    inspOpen = false;
    inspEl.classList.remove('on');
    if (inspAnchor) {
      inspAnchor.classList.remove('act');
      inspAnchor.setAttribute('aria-expanded', 'false');
      inspAnchor = null;
    }
  }
  function toggleInsp(anchor) {
    if (inspOpen && inspAnchor === anchor) { closeInsp(); return; }
    closeInsp();
    openInsp(anchor);
  }

  /* ---------- 拖动停靠：工具条可停到画面四条边的中点 ----------
     【需求】用户明确要求：工具条的笔/橡皮/指针等按钮可以拖到画面四条边（上、下、左、右）
     的中点。四个位置之外不要放开成自由摆放。
     【数据】停靠位写进 pref.dock，下次打开沿用；非法值一律回落到 bottom。 */
  function applyDock(d) {
    dock = DOCK_NAME[d] ? d : 'bottom';
    bar.setAttribute('data-dock', dock);
    if (inspOpen) placeInsp();            /* 面板跟着换到新的外侧 */
  }
  /* 离哪条边的中点最近就停哪条边 */
  function dockAt(x, y) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var pts = [['top', vw / 2, 0], ['bottom', vw / 2, vh], ['left', 0, vh / 2], ['right', vw, vh / 2]];
    var best = dock, bd = Infinity;
    for (var i = 0; i < pts.length; i++) {
      var dx = x - pts[i][1], dy = y - pts[i][2], d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = pts[i][0]; }
    }
    return best;
  }
  function dragBarTo(x, y) {
    bar.style.left = Math.round(barDrag.left + (x - barDrag.sx)) + 'px';
    bar.style.top = Math.round(barDrag.top + (y - barDrag.sy)) + 'px';
    barDrag.target = dockAt(x, y);
    Array.prototype.forEach.call(docksEl.children, function (h) {
      h.classList.toggle('on', h.getAttribute('data-dock') === barDrag.target);
    });
  }
  /* 【易错】拖动实现要点：①指针捕获加在抓手（grip）上，pointermove/up 才会回到抓手；
     ②拖动期间给 bar 加 .dragging（transform:none!important），否则停靠规则的
     translateX(-50%) 会和“跟手自由定位”打架；③松手必须清掉内联 left/top 并移除类，
     否则工具条会粘在松手处、下次停靠位置全错。抓手带 touch-action:none，iPad 上不会滚页。 */
  function startDockDrag(e) {
    if (!mode || barDrag) return;
    e.preventDefault();
    closeInsp();
    var r = bar.getBoundingClientRect();
    barDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, left: r.left, top: r.top, target: dock };
    try { gripEl.setPointerCapture(e.pointerId); } catch (err) {}
    bar.classList.add('dragging');
    /* 拖动期间先脱离停靠规则，改成自由跟随手指 */
    bar.style.left = Math.round(r.left) + 'px';
    bar.style.top = Math.round(r.top) + 'px';
    bar.style.right = 'auto';
    bar.style.bottom = 'auto';
    docksEl.classList.add('on');
    dragBarTo(e.clientX, e.clientY);
  }
  function endDockDrag(e) {
    if (!barDrag || (e && e.pointerId !== barDrag.id)) return;
    var t = barDrag.target, id = barDrag.id;
    barDrag = null;
    try { gripEl.releasePointerCapture(id); } catch (err) {}
    bar.classList.remove('dragging');
    docksEl.classList.remove('on');
    Array.prototype.forEach.call(docksEl.children, function (h) { h.classList.remove('on'); });
    bar.style.left = bar.style.top = bar.style.right = bar.style.bottom = '';
    applyDock(t);
    savePref();
    toastMsg('工具条已停靠到' + DOCK_NAME[dock]);
  }

  /* ---------- 事件绑定 ---------- */
  fab.addEventListener('click', function () { setMode(!mode); });
  root.getElementById('hidenote').addEventListener('click', function () { closeInsp(); setMode(false); });
  toolsBox.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || !b.getAttribute) return;
    var t = b.getAttribute('data-tool');
    if (!t) return;
    /* 【需求】工具按钮的两级交互（用户明确要求）：
       点一次 = 选中该工具；再点同一个按钮 = 展开它自己的“颜色 + 粗细”面板。
       颜色是工具的下级（不是独立工具栏），粗细与颜色同级。改这段前先确认这三条。 */
    if (t === tool) { toggleInsp(b); return; }
    closeInsp();
    setTool(t);
  });
  penOnlyBtn.addEventListener('click', togglePenOnly);
  /* 拖动停靠：抓手按下即开始拖；工具条自身的空白处也可以拖（按在按钮上仍是正常点按） */
  gripEl.addEventListener('pointerdown', startDockDrag);
  gripEl.addEventListener('pointermove', function (e) {
    if (!barDrag || e.pointerId !== barDrag.id) return;
    e.preventDefault();
    dragBarTo(e.clientX, e.clientY);
  });
  gripEl.addEventListener('pointerup', endDockDrag);
  gripEl.addEventListener('pointercancel', endDockDrag);
  bar.addEventListener('pointerdown', function (e) {
    if (!e.target.closest || !e.target.closest('button')) startDockDrag(e);
  });
  /* 点画布或页面别处就收起面板（点工具条自身不算） */
  document.addEventListener('pointerdown', function (e) {
    if (!inspOpen) return;
    var path = (e.composedPath && e.composedPath()) || [];
    for (var i = 0; i < path.length; i++) {
      if (path[i] === inspEl || path[i] === bar) return;
    }
    closeInsp();
  }, true);
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
  /* 【性能】滑杆拖动是高频道调用：拖动过程中只改内存（quiet=true，不写 localStorage），
     松手（change）才落盘一次。原先每次 input 都写一遍存储，连续拖动会在 iPad 上卡顿，
     也违背了 setWidth 里 quiet 参数的设计初衷。 */
  wsl.addEventListener('input', function () { setWidth(posToW(Number(wsl.value), tool), true); });
  wsl.addEventListener('change', function () { setWidth(curWidth()); });
  /* 【需求】色板：圆形色标 + 径向遮罩，与侧栏板块色标同一套写法（半透明、由内向外扩散）。
     【需求】颜色种类必须保持 5 个（黑/红/蓝/绿/橙，夜间模式换亮色），用户明确要求不变；
     色号与 pref.color 一一对应，键盘 1~5 也走同一套索引（pickColor），三处索引务必一致。 */
  function buildColors() {
    colorsBox.innerHTML = '';
    var cs = palette(), ns = paletteName();
    cs.forEach(function (c, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sw';
      b.title = ns[i];
      b.setAttribute('data-c', c);
      b.setAttribute('aria-label', '颜色 ' + ns[i]);
      b.setAttribute('aria-pressed', 'false');
      var d = document.createElement('i');
      d.className = 'swd';
      d.style.setProperty('--c', c);
      b.appendChild(d);
      b.addEventListener('click', function () { pickColor(i, c); });
      colorsBox.appendChild(b);
    });
    syncColors();
  }
  function pickColor(i, c) {
    if (tool === 'pencil' || tool === 'marker') { state[tool].c = c; pref.color[tool] = i; }
    else { state.pen.c = c; if (tool !== 'eraser') pref.color.pen = i; }
    syncColors();
    savePref();
  }
  /* 【需求】快捷键约定（用户已习惯，别改）：Ctrl/⌘+Z 撤销、加 Shift 或 Ctrl+Y 重做、
     1~5 选色、[ ] 调粗细、Delete/Backspace 删选中笔画、Esc 先收面板、再按才退出演算。
     注意首行的 `if (!mode) return`：非演算模式下这些键必须留给页面（例如搜索框输入）。 */
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
      if (inspOpen) closeInsp(); else setMode(false);
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
      pickColor(Number(k) - 1, palette()[Number(k) - 1]);
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
      if (inspOpen) placeInsp();          /* 视口变了，面板跟着重新贴回按钮 */
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
  /* 【性能】【需求】页面切走时：落定当前（含待续）那一笔并释放动画帧；回来时 resize + 重画。
     不落定的话 iPad 上切回来会出现半截笔画；不重画则会白屏。
     【易错】pagehide 把位图缩到 1x1 是刻意的内存保护，别以为是可以删掉的怪代码。 */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (rafLive) { cancelAnimationFrame(rafLive); rafLive = 0; }
      if (rafDraw) { cancelAnimationFrame(rafDraw); rafDraw = 0; }
      if (live) endStroke();                 /* 含“断笔待续”里挂着的那一笔 */
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
  /* 【易错】启动分两段：先把轮廓库拉起来 + 对齐尺寸 + 建 UI，再渲染首帧。
     本层**不读写任何笔迹**（【需求】每次打开都是干净画布，退出即清空）。
     applyDock 放在这里恢复上次的停靠位；漏掉它工具条会回到默认底部而不是用户选的位置。 */
  function boot() {
    if (booted) return;
    booted = true;
    loadOutline();                    /* 先把笔迹轮廓库拉起来（本地优先，失败走兜底） */
    readScroll();
    resize();
    applyDock(dock);                  /* 恢复上次停靠的位置 */
    buildColors();
    buildPresets();
    wsl.value = wToPos(curWidth(), tool);
    syncWidthUI();
    setTool(tool);
    syncUI();
    placeFab();
    /* 不在演算模式下时画布是 1×1 的空位图，这里没必要渲染首帧 */
    if (mode) { renderAll(); }
    if (DIAG) diagLog('环境', {
      coalesced: !!(window.PointerEvent && PointerEvent.prototype.getCoalescedEvents),
      predicted: !!(window.PointerEvent && PointerEvent.prototype.getPredictedEvents),
      pointerRawUpdate: !!window.onpointerrawupdate,
      dpr: curDPR(), penOnly: pref.penOnly, ua: navigator.userAgent
    });
  }
  /* 【接口】对外暴露的调试 / 联动接口，被各板块页和自动化测试直接调用，改名等于破坏调用方：
     count / mode / ready / setMode / setTool / setWidth / getWidth / outline / penOnly /
     diag / dock / clear。新增方法时请补一行用途说明。 */
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
    /* 断笔诊断快照：笔画数 / 每笔点数 / 正在写的那一笔的点数 / 取消与续写次数。
       在 iPad 上打开 ?xzdiag=1 后，写完几个字执行 __xzScratch.diag() 即可核对。 */
    diag: function () {
      return {
        down: diagStat.down, up: diagStat.up, cancel: diagStat.cancel,
        resume: diagStat.resume, maxPts: diagStat.maxPts, coalesced: diagStat.coalesced,
        drawing: drawing, livePts: live ? live.p.length / 3 : 0,
        pts: strokes.map(function (s) { return s.p.length / 3; })
      };
    },
    /* 工具条停靠位：'top' | 'bottom' | 'left' | 'right'（等于四边中点） */
    dock: function (d) { if (d) { applyDock(d); savePref(); } return dock; },
    clear: function () { strokes = []; undoStack = []; redoStack = []; renderAll(); syncUI(); }
  };

  syncUI();
  if (window.requestAnimationFrame) requestAnimationFrame(boot);
  else setTimeout(boot, 0);
})();
