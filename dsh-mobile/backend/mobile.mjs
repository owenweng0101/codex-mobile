import { createMobilePageState } from './page-state.mjs';
import { PREVIEW_ZOOM_SCRIPT } from './preview-zoom.mjs';
import { bindSidebarTouchGuard } from './sidebar-touch.mjs';
import { bindPreviewNavigation } from './preview-navigation.mjs';
import { installFileReadRecovery } from './file-read-recovery.mjs';
import { installMobileHubReadiness } from '../../claude-mobile/backend/lib/hub-readiness.mjs';
import { installDshLoadingGate } from './loading-gate.mjs';
import { isDshMobileReloadSafe } from './reload-safety.mjs';
import { installDshDraftNavigationGuard } from './draft-navigation.mjs';
/**
 * 手机端注入：让桌面版 Harness 界面在手机上可用。
 *
 * 只改页面外壳（viewpoint、抽屉式侧边栏、安全区、触控尺寸），不碰业务代码。
 * 侧边栏在窄屏改为覆盖式抽屉：打开时不挤压对话区，收起时只留图标轨道。
 */

const MOBILE_BREAKPOINT = 720;

const MOBILE_CSS = `
html[data-dshm-mobile] { -webkit-text-size-adjust: 100%; }
html[data-dshm-mobile] body { overscroll-behavior-y: none; }
html[data-dshm-mobile] * { -webkit-tap-highlight-color: transparent; }
#dshm-loading { position: fixed; inset: 0; z-index: 2147483000; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; background: var(--hub-canvas, var(--dsw-alias-bg-base, #f9fafb)); color: var(--hub-muted, #61666b); font: 14px/1.6 -apple-system, system-ui, "PingFang SC", sans-serif; }
#dshm-loading p { max-width: calc(100% - 48px); margin: 0; text-align: center; overflow-wrap: anywhere; }
#dshm-loading .dshm-recovery-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 8px; }
#dshm-loading button { min-height: 44px; padding: 10px 18px; font: inherit; color: var(--hub-canvas, #f9fafb); background: var(--hub-ink, #303236); border: 1px solid transparent; border-radius: 12px; cursor: pointer; }
#dshm-loading button[data-home] { background: transparent; color: inherit; border-color: var(--hub-line, #d9dce0); }
#dshm-loading button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
@media (prefers-color-scheme: dark) { #dshm-loading { background: var(--hub-canvas, var(--dsw-alias-bg-base, #151517)); color: var(--hub-muted, #aaafb7); } }

/* 触摸点按会让按钮（例如可折叠的“已完成，用时 …”状态行）在脚本里获得焦点。
   桌面靠 outline-color: transparent 抑制 pointer 焦点环，但 WebKit 绘制
   outline-style: auto 的原生焦点环时忽略颜色，手机上因此残留蓝色方框。
   触摸场景把焦点环换成可着色的实线样式，透明抑制和键盘焦点环都照常生效。 */
html[data-dshm-mobile][data-input-modality="pointer"] :focus-visible:not(:read-write) {
  outline-style: solid;
}

/* Neutral startup text, injected before the pinned boot module's first paint.
   Only the loading hint changes; native failure details and retry stay visible. */
html[data-dshm-mobile] [data-dsh-boot] :is([class*="_wordmark_"], [data-dsh-boot-spinner]) { display: none !important; }
html[data-dshm-mobile] [data-dsh-boot] [class*="_hint_"] { font-size: 0 !important; }
html[data-dshm-mobile] [data-dsh-boot] [class*="_hint_"]::after {
  content: '正在加载…';
  font: 14px/1.6 -apple-system, system-ui, "PingFang SC", sans-serif;
}
@media (prefers-reduced-motion: reduce) {
  html[data-dshm-mobile] [data-dshm-backdrop] { transition: none !important; }
}

/* Keep the brand and per-workspace creation controls; remove the redundant banner. */
html[data-dshm-mobile] button[aria-label="新建会话"][class*="_newSession"] {
  display: none !important;
}


/* 侧边栏：窄屏整体收起，只有抽屉打开时才出现；对话列始终占满整屏。 */
@media (max-width: ${MOBILE_BREAKPOINT}px) {
  html[data-dshm-mobile] [data-dshm-main] {
    grid-column: 1 / -1 !important;
    grid-row: 1 !important;
  }
  html[data-dshm-mobile] [data-dshm-sidebar] {
    grid-column: 1 !important;
    grid-row: 1 !important;
    position: relative;
    z-index: 60;
    background: var(--dshm-sidebar-bg, #fbfbfc);
    height: 100dvh;
  }
  html[data-dshm-mobile]:not([data-dshm-drawer="open"]) [data-dshm-sidebar] { display: none !important; }
  html[data-dshm-mobile][data-dshm-drawer="open"] [data-dshm-sidebar] {
    box-shadow: 0 12px 48px rgba(15, 23, 42, 0.18);
  }
  html[data-dshm-mobile] [data-dshm-backdrop] {
    position: fixed; inset: 0;
    z-index: 59;
    background: rgba(15, 23, 42, 0.32);
    opacity: 0;
    pointer-events: none;
    transition: opacity 160ms ease;
  }
  html[data-dshm-mobile][data-dshm-drawer="open"] [data-dshm-backdrop] { opacity: 1; pointer-events: auto; }

  /* 手机上无意义的桌面控件：文件管理器、右侧面板、页签、窗口操作、统计行。 */
  html[data-dshm-mobile] [aria-label="用 访达 打开"],
  html[data-dshm-mobile] [aria-label="更多打开方式"],
  html[data-dshm-mobile] [aria-label="打开右侧边栏"],
  html[data-dshm-mobile] [aria-label="收起右侧边栏"],
  html[data-dshm-mobile] [aria-label="新标签页"],
  html[data-dshm-mobile] [aria-label="分栏"],
  html[data-dshm-mobile] [aria-label="全屏"],
  html[data-dshm-mobile] [aria-label="插件"],
  html[data-dshm-mobile] [aria-label="自动化任务"],
  html[data-dshm-mobile] [aria-label="打开侧边栏"],
  html[data-dshm-mobile] [data-conversation-tabs],
  html[data-dshm-mobile] [data-composer-stat],
  html[data-dshm-mobile] [data-composer-dock],
  html[data-dshm-mobile] [data-dshm-tabs],
  /* 统计行在提问/审批卡片占用输入位时会收成 0 宽；标记绝不能落在输入区上，
     否则会把提问卡片一起藏掉（手机上就没法回答了）。 */
  html[data-dshm-mobile] [data-dshm-stats]:not([data-composer-seat]),
  html[data-dshm-mobile] [aria-label="更多操作"] { display: none !important; }

  /* Restore the native tail action on the centre axis. Its existing slot owns
     composer-relative height, safe-area clearance and below-composer stacking;
     native followingTail still mounts/unmounts the only button. */
  html[data-dshm-mobile] [class~="tnXGgG_toBottomSlot"] {
    justify-content: center !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
  }
  /* Match Codex's visible size-7 circle and size-4 arrow. The transparent
     hit extension keeps a 44px touch target without painting a 44px circle. */
  html[data-dshm-mobile] button[class~="tnXGgG_toBottom"] {
    position: relative;
    overflow: visible;
    box-sizing: border-box !important;
    display: grid;
    place-items: center;
    width: 28px !important;
    height: 28px !important;
    margin-top: -28px !important;
    padding: 0 !important;
    border: 1px solid var(--hub-line, #e5e7ea) !important;
    border-radius: 9999px;
    background: var(--hub-panel, var(--dsw-alias-bg-base, #f9fafb)) !important;
    color: var(--hub-ink, #0f1115) !important;
    box-shadow: 0 1px 3px 0 rgb(0 0 0 / .1), 0 1px 2px -1px rgb(0 0 0 / .1) !important;
    -webkit-appearance: none;
    appearance: none;
    touch-action: manipulation;
  }
  html[data-dshm-mobile] button[class~="tnXGgG_toBottom"] > svg { display: none !important; }
  html[data-dshm-mobile] button[class~="tnXGgG_toBottom"]::before {
    content: "";
    width: 16px;
    height: 16px;
    background: currentColor;
    pointer-events: none;
    -webkit-mask: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='1.5'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M12%205v14'/%3E%3Cpath%20d='m19%2012-7%207-7-7'/%3E%3C/svg%3E") center / contain no-repeat;
    mask: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='1.5'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M12%205v14'/%3E%3Cpath%20d='m19%2012-7%207-7-7'/%3E%3C/svg%3E") center / contain no-repeat;
  }
  html[data-dshm-mobile] button[class~="tnXGgG_toBottom"]::after {
    content: "";
    position: absolute;
    inset: -8px;
    border-radius: inherit;
  }
  @media (hover: hover) {
    html[data-dshm-mobile] button[class~="tnXGgG_toBottom"]:hover { background: var(--hub-hover, #eceef0) !important; }
  }

  /* 固定版在 hover:none 隐藏更新时间；手机保留时间，菜单和选中态也不替换它。 */
  html[data-dshm-mobile] [data-dshm-sidebar] [data-row-key^="session:"] [class*="rowResting"] {
    display: inline-flex !important;
    flex-shrink: 0 !important;
    margin-inline-end: 8px !important;
  }
  html[data-dshm-mobile] [data-dshm-sidebar] [data-row-key^="session:"] [class*="timestamp"] {
    display: inline-block !important;
    white-space: nowrap !important;
  }

  /* 会话行右侧的「…」常显：手机上不需要先选中才出现操作入口。 */
  html[data-dshm-mobile] [data-dshm-sidebar] [class*="rowActions"] {
    display: inline-flex !important;
    width: auto !important;
    overflow: visible !important;
  }
  /* 只保留「…」菜单（里面已有归档/置顶），其余悬浮图标不常显，避免挤占标题。 */
  html[data-dshm-mobile] [data-dshm-sidebar] [aria-label="归档会话"],
  html[data-dshm-mobile] [data-dshm-sidebar] [aria-label="置顶会话"] { display: none !important; }
  html[data-dshm-mobile] [data-dshm-sidebar] [class*="rowActions"] { pointer-events: auto !important; }
  html[data-dshm-mobile] [data-dshm-sidebar] [aria-label$="的操作"] {
    width: 22px !important;
    min-width: 22px !important;
    height: 22px !important;
    opacity: 1 !important;
    pointer-events: auto !important;
    position: relative !important;
    z-index: 2 !important;
  }

  /* 手机上不需要的入口：全局面板（插件/自动化/更多）与左下角账号。 */
  html[data-dshm-mobile] [data-dshm-sidebar] [class*="panelList"],
  html[data-dshm-mobile] [data-dshm-sidebar] [class*="footArea"] { display: none !important; }

  /* 手机表格在正文容器内滚动，不继承桌面 md-table-wide 的 cqw 加宽和负偏移。
     避免 iOS 微信的 WebKit 将容器单位、负偏移与百分比表宽叠加后裁掉内容。 */
  html[data-dshm-mobile] .md-table-wide {
    --dsh-table-spare: 0px !important;
    --dsh-table-lead: 0px !important;
    box-sizing: border-box !important;
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
    padding: 0 !important;
    overflow-x: auto !important;
    overscroll-behavior-x: contain;
  }
  html[data-dshm-mobile] .md-table-wide > table {
    position: static !important;
    z-index: auto !important;
  }

  /* 表格沿用细横线和浅表头；四列及以上留足阅读宽度，由外层横向滚动。 */
  html[data-dshm-mobile] table {
    width: 100% !important;
    max-width: none !important;
    table-layout: fixed !important;
    border-collapse: separate !important;
    border-spacing: 0 !important;
    margin: 10px 0 !important;
    font-size: 13px !important;
    line-height: 1.6 !important;
    border: 1px solid rgba(15, 23, 42, 0.09) !important;
    border-radius: 10px !important;
    overflow: hidden !important;
  }
  html[data-dshm-mobile] .md-table-wide > table:has(tr > :nth-child(4)) {
    min-width: 560px !important;
  }
  html[data-dshm-mobile] th,
  html[data-dshm-mobile] td {
    min-width: 0 !important;
    max-width: none !important;
    padding: 9px 12px !important;
    text-align: left !important;
    vertical-align: top !important;
    border: 0 !important;
    border-bottom: 1px solid rgba(15, 23, 42, 0.07) !important;
    word-break: break-word !important;
    overflow-wrap: anywhere !important;
  }
  html[data-dshm-mobile] tr:last-child td { border-bottom: 0 !important; }
  html[data-dshm-mobile] thead th {
    background: rgba(15, 23, 42, 0.035) !important;
    font-weight: 600 !important;
    color: #3d4350 !important;
  }
  html[data-dshm-mobile] tbody tr:nth-child(even) td { background: rgba(15, 23, 42, 0.015) !important; }

  /* 固定版未包含鲸鱼动画贴图：隐藏整块图标占位，让求索文字与正文左对齐。
     使用运行状态的语义标记，兼容前端重新渲染，不依赖文字或混淆后的类名前缀。 */
  html[data-dshm-mobile] [data-chat-running] [class$="_runningIcon"] {
    display: none !important;
  }
  html[data-dshm-mobile] [data-chat-running] [class$="_runningContent"] {
    gap: 0 !important;
    margin-left: 0 !important;
    padding-left: 0 !important;
  }

  /* 弹出菜单保持应用自己的尺寸，只避免超出屏幕。 */
  html[data-dshm-mobile] [role="menu"] { max-width: calc(100vw - 16px) !important; max-height: 60vh !important; overflow-y: auto !important; }

  /* 输入工具条首帧即使用固定包的行标识，不等 observer 打标才改变高度/对齐。 */
  html[data-dshm-mobile] :is([data-dshm-toolbar], [data-composer-card] > [class~="JZLxKW_row"]) { padding-top: 4px !important; padding-bottom: 4px !important; align-items: center !important; flex-wrap: nowrap !important; }
  html[data-dshm-mobile] :is([data-dshm-toolbar], [data-composer-card] > [class~="JZLxKW_row"]) > * { align-self: center !important; }
  html[data-dshm-mobile] :is([data-dshm-toolbar], [data-composer-card] > [class~="JZLxKW_row"]) button { margin-top: 0 !important; margin-bottom: 0 !important; align-self: center !important; }
  /* 只统一加号和主操作纯图标按钮，绝不能碰模型名等带文字的按钮。
     主按钮使用固定包的身份覆盖发送中/排队/插话/停止，不随 aria-label 切回桌面尺寸。
     直接以输入卡片为作用域，不等 JS 标记工具条，草稿恢复的首帧也不会先跳成桌面尺寸。
     固定 32×32 的容器，图标用 grid 单格居中：iOS 的 button 自带 1px/6px 内边距
     和 -webkit-appearance，只写 margin:auto 会让 14px 的 svg 在圆底里偏 2~3px。 */
  html[data-dshm-mobile] [data-composer-card] button[class~="JZLxKW_primary"],
  html[data-dshm-mobile] [data-composer-card] button[aria-label="添加文件或调用指令"],
  html[data-dshm-mobile] [data-composer-card] button[aria-label="发送消息"],
  html[data-dshm-mobile] [data-composer-card] button[aria-label="插话发送"],
  html[data-dshm-mobile] [data-composer-card] button[aria-label="停止生成"] {
    box-sizing: border-box !important;
    height: 32px !important;
    width: 32px !important;
    min-width: 32px !important;
    flex: 0 0 32px !important;
    align-self: center !important;
    padding: 0 !important;
    margin: 0 !important;
    display: grid !important;
    place-items: center !important;
    place-content: center !important;
    line-height: 0 !important;
    -webkit-appearance: none !important;
    appearance: none !important;
    /* 应用给发送按钮加了 translateY(-2px) 做视觉微调，手机上看就是没对齐。 */
    transform: none !important;
  }
  html[data-dshm-mobile] [data-composer-card] button[class~="JZLxKW_primary"] svg,
  html[data-dshm-mobile] [data-composer-card] button[aria-label="添加文件或调用指令"] svg,
  html[data-dshm-mobile] [data-composer-card] button[aria-label="发送消息"] svg,
  html[data-dshm-mobile] [data-composer-card] button[aria-label="插话发送"] svg,
  html[data-dshm-mobile] [data-composer-card] button[aria-label="停止生成"] svg {
    display: block !important;
    margin: 0 !important;
    grid-area: 1 / 1 !important;
  }

  /* 目标栏：条高 36px、按钮只有 28px，手指很难点准；放大按钮到 32px，
     目标文字先省略，右侧的暂停/编辑/清除永远留在屏幕里。 */
  /* The pinned composer card has 16px side gutters. Goal's old 100% width
     and Todo's desktop 32px margins made three different edges on a phone. */
  html[data-dshm-mobile] :is([data-goal-bar], [data-testid="todo-panel"]) {
    box-sizing: border-box !important;
    width: calc(100% - 32px) !important;
    max-width: none !important;
    min-width: 0 !important;
    margin-left: 16px !important;
    margin-right: 16px !important;
    align-self: center !important;
  }
  html[data-dshm-mobile] [data-goal-bar] > div {
    height: auto !important;
    min-height: 40px !important;
    padding: 4px 6px 4px 10px !important;
    gap: 6px !important;
  }
  html[data-dshm-mobile] [data-goal-bar] > div > span { min-width: 0 !important; }
  html[data-dshm-mobile] [data-goal-bar] button {
    flex: 0 0 32px !important;
    width: 32px !important;
    height: 32px !important;
    min-width: 32px !important;
    padding: 0 !important;
    display: inline-grid !important;
    place-items: center !important;
    -webkit-appearance: none !important;
    appearance: none !important;
  }

  /* 触摸：去掉双击缩放等待，点一下就响应。 */
  html[data-dshm-mobile] [data-dshm-sidebar] [role="treeitem"],
  html[data-dshm-mobile] [data-dshm-sidebar] button { touch-action: manipulation; }

  /* 键盘快捷键提示（⌥⌘N 之类）在手机上无意义。 */
  html[data-dshm-mobile] [data-dshm-sidebar] kbd { display: none !important; }

  /* 手机上没有 hover：附件删除按钮常显，避免"看不见就删不掉"。 */
  html[data-dshm-mobile] [aria-label^="移除图片"],
  html[data-dshm-mobile] [aria-label^="移除附件"] { opacity: 1 !important; }
  html[data-dshm-mobile] *:has(> [aria-label^="移除图片"]) { opacity: 1 !important; }

  /* 隐藏滚动条：应用给桌面滚动条预留的 5px 会让输入卡左右不对称。 */
  html[data-dshm-mobile] *::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
  html[data-dshm-mobile] * { scrollbar-width: none; }

  /* 会话列表页：整屏；返回按钮与品牌行同一排。 */
  html[data-dshm-mobile][data-dshm-drawer="open"] [data-dshm-sidebar] {
    width: 100vw !important;
    max-width: 100vw !important;
    visibility: visible !important;
    transform: none !important;
    transition: none !important;
    box-shadow: none !important;
    box-sizing: border-box;
  }
  /* The pinned brand row must have its final size before any observer tags it. */
  html[data-dshm-mobile] [class~="kB3qhq_logoRow"],
  html[data-dshm-mobile] [data-dshm-logo] { padding-left: 12px !important; padding-top: 0 !important; padding-bottom: 0 !important; height: 44px !important; min-height: 44px !important; box-sizing: border-box; }
  html[data-dshm-mobile] [data-dshm-session-restore] { padding: 24px; color: var(--dsw-alias-label-secondary, #5b6170); font-size: 14px; }
  html[data-dshm-mobile] [data-dshm-sidebar] [class*="_sectionLabel"] { margin-left: 1px; }
  /* 品牌行右侧的收起按钮与左侧返回重复，隐藏（仍可被脚本点击）。 */
  html[data-dshm-mobile] [data-dshm-sidebar] [aria-label="收起侧边栏"] { display: none !important; }
  html[data-dshm-mobile][data-dshm-drawer="open"] [data-dshm-sidebar] > div,
  html[data-dshm-mobile][data-dshm-drawer="open"] [data-dshm-sidebar] > div > div,
  html[data-dshm-mobile][data-dshm-drawer="open"] [data-dshm-sidebar] > div > div > div { width: 100% !important; }
  html[data-dshm-mobile][data-dshm-drawer="open"] [data-dshm-backdrop] { display: none !important; }
  /* 列表页由脚本自己控制显隐，遮罩始终不用。 */
  html[data-dshm-mobile] [data-dshm-backdrop] { display: none !important; }
  /* 新版自带的窄屏遮罩不参与手机壳的整屏列表导航。 */
  html[data-dshm-mobile] [data-sidebar-mask] { display: none !important; }

  /* 返回：裸箭头，不画按钮框，减少顶部视觉重量。 */
  html[data-dshm-mobile] [data-dshm-header] { position: relative !important; }
  html[data-dshm-mobile] [data-dshm-menu][data-dshm-anchor="header"] {
    position: absolute;
    left: 6px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 58;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: #4b5563;
    box-shadow: none;
    cursor: pointer;
  }

  /* 列表页是根页面，不需要返回。 */
  html[data-dshm-mobile][data-dshm-drawer="open"] [data-dshm-menu] { display: none !important; }
  /* 标题栏：让出返回箭头的宽度，同时压低高度与字号。 */
  html[data-dshm-mobile] [data-dshm-header] {
    padding-left: 42px !important;
    padding-right: 12px !important;
    box-sizing: border-box !important;
    padding-top: 4px !important;
    padding-bottom: 4px !important;
    height: 52px !important;
    min-height: 0 !important;
    align-items: center !important;
  }
  html[data-dshm-mobile] [data-dshm-header] [class*="titleRow"] { height: 44px !important; min-height: 0 !important; }
  html[data-dshm-mobile] [data-dshm-crumbs] { font-size: 15px !important; font-weight: 500 !important; }

  /* 让页面铺满刘海屏，同时把内容让进安全区（iOS 的 Home 指示条 / 状态栏）。 */
  html[data-dshm-mobile] [data-dshm-frame] {
    box-sizing: border-box;
    height: 100dvh;
    padding-top: env(safe-area-inset-top, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  /* 右侧边栏（文件 / 图片 / 本轮改动预览）：手机上就是整屏抽屉。
     应用按列宽排版，窄屏下这一列会被挤到网格第二行、高度塌成 0，所以这里让它
     始终占满视口（应用排版才正常，右上角的按钮也才点得到），只用可见性控制开合。 */
  html[data-dshm-mobile] [data-rightbar-col] {
    position: fixed !important;
    inset: 0 !important;
    width: 100vw !important;
    max-width: 100vw !important;
    height: 100dvh !important;
    z-index: 70 !important;
    background: var(--dsw-alias-bg-base, #fff) !important;
    padding-top: env(safe-area-inset-top, 0px) !important;
    padding-bottom: env(safe-area-inset-bottom, 0px) !important;
  }
  html[data-dshm-mobile]:not([data-dshm-rightbar="open"]) [data-rightbar-col] {
    transform: translateX(100%) !important;
    pointer-events: none !important;
  }
  /* 面板自带桌面记下的宽度（内联 864px），这里铺满；差异视图自己会横向滚动。 */
  html[data-dshm-mobile][data-dshm-rightbar="open"] [data-sidebar-right-panel] {
    width: 100% !important;
    height: 100% !important;
    left: 0 !important;
    right: 0 !important;
    top: 0 !important;
  }
  /* 抽屉顶部工具条：整屏之后分栏/全屏/新标签页没有意义，只留「收起」这个出口。
     桌面头部的同名按钮本来是隐藏的，这里把它放出来当抽屉的关闭键。 */
  html[data-dshm-mobile][data-dshm-rightbar="open"] [data-rightbar-col] [aria-label="分栏"],
  html[data-dshm-mobile][data-dshm-rightbar="open"] [data-rightbar-col] [aria-label="全屏"],
  html[data-dshm-mobile][data-dshm-rightbar="open"] [data-rightbar-col] [aria-label="退出全屏"],
  html[data-dshm-mobile][data-dshm-rightbar="open"] [data-rightbar-col] [aria-label="新标签页"] { display: none !important; }
  html[data-dshm-mobile][data-dshm-rightbar="open"] [data-rightbar-col] [aria-label="收起右侧边栏"] {
    display: inline-grid !important;
    place-items: center !important;
    flex: 0 0 auto !important;
    width: 32px !important;
    height: 32px !important;
    margin-right: 4px !important;
    visibility: visible !important;
  }
  /* 抽屉本身就是整屏，「收起」画成「退出全屏」的向内箭头，而不是桌面的分栏图标。
     用 mask 画在伪元素上：图标随按钮文字色，应用重渲染换掉 svg 也不受影响。 */
  html[data-dshm-mobile][data-dshm-rightbar="open"] [data-rightbar-col] [aria-label="收起右侧边栏"] > * { display: none !important; }
  html[data-dshm-mobile][data-dshm-rightbar="open"] [data-rightbar-col] [aria-label="收起右侧边栏"]::before {
    content: "";
    width: 18px;
    height: 18px;
    background: currentColor;
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7'/%3E%3C/svg%3E") center / contain no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7'/%3E%3C/svg%3E") center / contain no-repeat;
  }
  /* 预览头部的「用 某某应用 打开」：手机上打不开桌面应用，抽屉只用来看附件。 */
  html[data-dshm-mobile] [data-rightbar-col] [aria-label^="用 "][aria-label$=" 打开"],
  html[data-dshm-mobile] [data-rightbar-col] [aria-label="更多打开方式"] { display: none !important; }
  /* 附件预览头部：iOS 上应用自带的头部样式可能没生效，路径独占一行、格式和刷新
     掉到第二行，按钮还露出系统灰底。按稳定的 data-* 属性兜底：一行排下、路径省略、
     右侧按钮保持紧凑并去掉系统按钮外观。 */
  html[data-dshm-mobile] [data-rightbar-col] [data-document-preview] {
    display: flex !important;
    flex-direction: column !important;
    min-height: 0 !important;
    padding-top: 8px !important;
    box-sizing: border-box !important;
  }
  /* The tab strip already names the file. Omit the path / refresh / format
     toolbar for every document type and give the height back to the reader. */
  html[data-dshm-mobile] [data-rightbar-col] [data-document-preview] > div:first-child {
    display: none !important;
  }
  html[data-dshm-mobile] [data-rightbar-col] [data-textpreview-path] {
    display: block !important;
    flex: 1 1 auto !important;
    min-width: 0 !important;
    overflow: hidden !important;
    white-space: nowrap !important;
    text-overflow: ellipsis !important;
    font-size: 12px !important;
  }
  html[data-dshm-mobile] [data-rightbar-col] [data-document-preview] > div:first-child > :not([data-textpreview-path]) { flex: 0 0 auto !important; }
  html[data-dshm-mobile] [data-rightbar-col] [data-document-viewer-menu],
  html[data-dshm-mobile] [data-rightbar-col] [data-textpreview-tool] {
    -webkit-appearance: none !important;
    appearance: none !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    height: 28px !important;
    min-width: 28px !important;
    padding: 0 6px !important;
    margin: 0 !important;
    border: 0 !important;
    border-radius: 6px !important;
    background: transparent !important;
    color: var(--dsw-alias-label-secondary, #5b6170) !important;
    font-size: 12px !important;
    line-height: 1 !important;
  }
  html[data-dshm-mobile] [data-rightbar-col] [data-textpreview-tool] svg { width: 16px !important; height: 16px !important; }
  html[data-dshm-mobile] [data-document-zoom-scrollport]:has([data-image-preview]) { touch-action: none !important; }
  html[data-dshm-mobile] [data-document-zoom-scrollport]:has([data-pdf-preview]) { touch-action: pan-x pan-y !important; }
  html[data-dshm-mobile] [data-image-preview] img { -webkit-touch-callout: none; -webkit-user-drag: none; }
  /* One scroll owner per document. Nested tab and Markdown scrollers can latch
     onto the outer (non-scrolling) tab after returning from an image on iOS. */
  html[data-dshm-mobile] [data-rightbar-col] [class*="_tabHostBody"]:has([data-document-preview]) { overflow: hidden !important; }
  html[data-dshm-mobile] [data-textpreview-body]:has([data-document-markdown]) {
    overflow: auto !important;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
  /* HTML 预览框：没有样式时 iframe 是默认的 300×150；宽度铺满，高度由脚本按剩余屏幕补满。 */
  html[data-dshm-mobile] [data-rightbar-col] iframe[data-html-preview] {
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
    border: 0 !important;
  }
  /* 标签页标题省略，别和关闭的 × 叠在一起。 */
  html[data-dshm-mobile] [data-rightbar-col] [role="tab"] { min-width: 0 !important; }
  html[data-dshm-mobile] [data-rightbar-col] [role="tab"] [class*="tabTitle"] { min-width: 0 !important; overflow: hidden !important; }
  html[data-dshm-mobile] [data-rightbar-col] [role="tab"] [class*="titleText"] {
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
  }
  /* 单栏预览保留明确的关闭入口，不依赖桌面 hover 才出现。 */
  html[data-dshm-mobile] [data-rightbar-col] [role="tab"] button[aria-label="关闭"] {
    display: inline-flex !important;
    opacity: 1 !important;
    visibility: visible !important;
    position: static !important;
    flex: 0 0 28px !important;
    width: 28px !important;
    height: 28px !important;
    align-items: center !important;
    justify-content: center !important;
  }
  /* 标签页里的小图标让位给标题，标题超长用省略号收尾。 */
  html[data-dshm-mobile] [data-rightbar-col] [role="tab"] svg { display: none !important; }
  html[data-dshm-mobile] [data-rightbar-col] [role="tab"] button[aria-label="关闭"] svg { display: block !important; }
  html[data-dshm-mobile] [data-rightbar-col] [data-dockkit-split-control] { display: none !important; }
  html[data-dshm-mobile] [data-rightbar-col] [role="tab"] { touch-action: pan-x !important; }
  html[data-dshm-mobile] [data-rightbar-col] [role="tab"] [data-dockkit-tab-title] {
    display: block !important;
    min-width: 0 !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
    line-height: 24px !important;
  }
  /* 文件头的绝对路径改成左对齐、末尾省略，别把开头裁掉看着像坏掉。 */
  html[data-dshm-mobile] [data-rightbar-col] [class*="_path_"] { justify-content: flex-start !important; overflow: hidden !important; }
  html[data-dshm-mobile] [data-rightbar-col] [class*="_path_"] [class*="_text_"] {
    min-width: 0 !important;
    max-width: 100% !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
  }
  /* 标签给足最小宽度，多了就横向滚动，别把标题压成「第 1 轮改」。 */
  html[data-dshm-mobile] [data-rightbar-col] [role="tab"] { flex: 0 0 auto !important; min-width: 104px !important; }
  html[data-dshm-mobile] [data-rightbar-col] [class*="stripTabs"] { overflow-x: auto !important; scrollbar-width: none; }
  /* 桌面的「开始」引导页在手机上只是噪音。 */
  html[data-dshm-mobile] [data-rightbar-col] [data-dshm-tab-hide] { display: none !important; }

  /* Non-modal navigation warning: never covers the composer with a click shield. */
  html[data-dshm-mobile] [data-dshm-draft-warning] {
    position: fixed; z-index: 80; left: 50%; top: calc(60px + env(safe-area-inset-top, 0px));
    transform: translateX(-50%); box-sizing: border-box; width: max-content; max-width: calc(100vw - 32px);
    padding: 10px 14px; border-radius: 10px; background: var(--dsw-alias-label-primary, #303236);
    color: var(--dsw-alias-bg-base, #f9fafb); font: 14px/1.5 -apple-system, system-ui, sans-serif;
    pointer-events: none; text-align: center; overflow-wrap: anywhere;
  }

  /* Keep both the editor and its scrollport at the empty draft's height.
     Long drafts scroll inside the editor; attachment rows remain separate. */
  html[data-dshm-mobile] [data-composer-card] > [data-input-scroll] {
    --dshm-input-height: 36px;
    flex: 0 0 auto !important;
    height: var(--dshm-input-height) !important;
    min-height: var(--dshm-input-height) !important;
    max-height: var(--dshm-input-height) !important;
    overflow-y: auto !important;
    overscroll-behavior-y: contain;
  }
  /* The pinned frontend's new-session composer starts with two text lines. */
  html[data-dshm-mobile] [class~="JZLxKW_hero"] [data-composer-card] > [data-input-scroll] {
    --dshm-input-height: 52px;
  }
  html[data-dshm-mobile] [data-composer-card] > [data-input-scroll] [data-composer-input] {
    height: var(--dshm-input-height) !important;
    min-height: var(--dshm-input-height) !important;
    max-height: var(--dshm-input-height) !important;
    overflow-y: auto !important;
    overscroll-behavior-y: contain;
  }

  /* 输入框工具条：模型与发送固定在右侧，不随左侧按钮宽度漂移。 */
  html[data-dshm-mobile] :is([data-dshm-toolbar], [data-composer-card] > [class~="JZLxKW_row"]) > *:last-child { margin-left: auto !important; }
  /* 新版紧凑模式会把长模型名和推理等级全藏成图标。手机保留文字，超长省略。 */
  html[data-dshm-mobile] :is([data-dshm-toolbar], [data-composer-card] > [class~="JZLxKW_row"]) [aria-label^="选择模型，当前"] {
    max-width: min(220px, calc(100vw - 190px)) !important;
    min-width: 0 !important;
  }
  html[data-dshm-mobile] :is([data-dshm-toolbar], [data-composer-card] > [class~="JZLxKW_row"]) [aria-label^="选择模型，当前"] [class*="triggerIcon"] {
    display: none !important;
  }
  html[data-dshm-mobile] :is([data-dshm-toolbar], [data-composer-card] > [class~="JZLxKW_row"]) [aria-label^="选择模型，当前"] [class*="triggerLabel"] {
    display: block !important;
    min-width: 0 !important;
    overflow: hidden !important;
    white-space: nowrap !important;
    text-overflow: ellipsis !important;
  }
  html[data-dshm-mobile] :is([data-dshm-toolbar], [data-composer-card] > [class~="JZLxKW_row"]) [aria-label^="选择模型，当前"] [class*="triggerEffort"] {
    display: block !important;
    flex: 0 0 auto !important;
  }
  /* 沿用升级前手机壳：返回 + 标题，隐藏桌面工具与扩展状态。 */
  html[data-dshm-mobile] [data-dshm-header] [class*="headerActions"],
  html[data-dshm-mobile] [data-dshm-header] [class*="headerUtilities"],
  html[data-dshm-mobile] [data-dshm-header] [data-conversation-header-leading],
  html[data-dshm-mobile] [data-dshm-header] [data-conversation-header-corner],
  html[data-dshm-mobile] [data-dshm-header] [class*="_tabs"] { display: none !important; }
  html[data-dshm-mobile] [data-dshm-header] [class*="titleRow"] {
    display: flex !important;
    width: 100% !important;
    min-width: 0 !important;
    gap: 0 !important;
    padding: 0 !important;
    box-sizing: border-box !important;
  }
  html[data-dshm-mobile] [data-dshm-header] [class*="titleCluster"] {
    flex: 1 1 auto !important;
    min-width: 0 !important;
    overflow: hidden !important;
    padding: 0 !important;
    margin: 0 !important;
  }
  html[data-dshm-mobile] [data-dshm-crumbs] {
    flex: 1 1 auto !important;
    min-width: 0 !important;
    overflow: hidden !important;
    white-space: nowrap !important;
    text-overflow: ellipsis !important;
  }
  /* 标题行禁止换行：点开状态胶囊再返回时，应用重渲染会把它挤成两行。 */
  html[data-dshm-mobile] [data-dshm-header],
  html[data-dshm-mobile] [data-dshm-header] div { flex-wrap: nowrap !important; }


  html[data-dshm-mobile] [data-dshm-divider] { display: none !important; }

  /* 输入框在 iOS 上小于 16px 会触发自动放大。 */
  html[data-dshm-mobile] textarea, html[data-dshm-mobile] [contenteditable="true"] { font-size: max(16px, 1em); }
}

/* 安全区：底部留出 Home 指示条。 */
html[data-dshm-mobile] { --dshm-safe-bottom: env(safe-area-inset-bottom, 0px); --dshm-safe-top: env(safe-area-inset-top, 0px); }

/* 窄屏（iPhone SE 等）：标题省略，保留返回与更多的触控区域。 */
@media (max-width: 380px) {
  html[data-dshm-mobile] [data-dshm-crumbs] { min-width: 48px !important; }
  html[data-dshm-mobile] [data-dshm-header] { padding-left: 38px !important; }
}
`;

const MOBILE_SCRIPT = `
(() => {
  (${installFileReadRecovery.toString()})(window);
  const BP = ${MOBILE_BREAKPOINT};
  const root = document.documentElement;
  const mobile = window.matchMedia('(max-width: ' + BP + 'px)');
  window.__dshMobileReloadSafe = () => (${isDshMobileReloadSafe.toString()})(document, window);
  const localReadiness = (${installMobileHubReadiness.toString()})(window);
  (${installDshDraftNavigationGuard.toString()})({ document, view: window, isMobile: () => mobile.matches, isSafe: () => window.__dshMobileReloadSafe() });
  (${installDshLoadingGate.toString()})({ document, view: window, inspect: () => localReadiness.inspect({dataset:{frame:'dsh'},contentDocument:document,contentWindow:window}), returnHome: () => window.__mobileHubHome() });
  // Tabs switch on click and scroll horizontally; a touch must never begin dock dragging.
  for (const type of ['pointerdown', 'dragstart']) window.addEventListener(type, event => {
    if (mobile.matches && event.target instanceof Element
      && event.target.closest('[data-rightbar-col] [role="tab"]')) {
      event.stopPropagation();
      if (type === 'dragstart') event.preventDefault();
    }
  }, true);
  let frame = null;
  let sidebar = null;
  let main = null;
  let backdrop = null;
  let menu = null;
  let autoWrapped = false;
  let taggedHeader = null;
  let taggedTabs = null;
  let taggedStats = null;
  let taggedLogo = null;
  let taggedToolbar = null;
  let taggedCrumbs = null;

  const toggleButton = () => document.querySelector('button[aria-label="收起侧边栏"], button[aria-label="打开侧边栏"]');

  function findFrame() {
    const button = document.querySelector('button[aria-label="新建会话"]');
    if (!button) return null;
    let node = button;
    while (node && node !== document.body) {
      if (getComputedStyle(node).display === 'grid' && node.children.length >= 2) return node;
      node = node.parentElement;
    }
    return null;
  }

  function ensureBackdrop() {
    if (backdrop && backdrop.isConnected) return;
    backdrop = document.createElement('div');
    backdrop.setAttribute('data-dshm-backdrop', '');
    backdrop.addEventListener('click', () => {
      const button = toggleButton();
      if (button) button.click();
    });
    document.body.appendChild(backdrop);
  }

  // 「开始」是应用的引导页，桌面上有用，手机上只是多出来一个看不懂的标签。
  function hideGuideTab(col) {
    for (const tab of col.querySelectorAll('[role="tab"]')) {
      const hide = (tab.textContent || '').trim() === '开始';
      if (hide && !tab.hasAttribute('data-dshm-tab-hide')) tab.setAttribute('data-dshm-tab-hide', '');
      else if (!hide && tab.hasAttribute('data-dshm-tab-hide')) tab.removeAttribute('data-dshm-tab-hide');
    }
  }

  // 差异视图默认不换行，窄屏上一行代码能撑到 1000px 宽、被裁掉一半。
  // 抽屉打开后自动打开一次「自动换行」；用户自己关掉就不再插手。
  function autoWrapDiff() {
    if (autoWrapped) return;
    const wrap = document.querySelector('[data-rightbar-col] button[aria-label="自动换行"]');
    if (!wrap) return;
    if (wrap.getAttribute('aria-pressed') !== 'true') wrap.click();
    autoWrapped = true;
  }

  // 返回箭头只挂在会话标题栏里。刷新时应用还没渲染出标题栏，以前会先挂到 body 上，
  // 没有样式的系统按钮（蓝色箭头）在左上角闪一下又消失；现在等标题栏出现再创建。
  // 在完整点击时切换列表，避免 pointerdown 换页后穿透点击和全局吞点击。
  (${bindSidebarTouchGuard.toString()})(window, () => mobile.matches, () => sidebar);

  function ensureMenu(host) {
    if (menu && menu.isConnected) return menu;
    menu = document.createElement('button');
    menu.type = 'button';
    menu.setAttribute('data-dshm-menu', '');
    const activate = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (listOpen) closeList();
      else openList();
    };
    menu.addEventListener('click', activate);
    host.appendChild(menu);
    menu.setAttribute('data-dshm-anchor', 'header');
    return menu;
  }

  // 返回箭头始终是同一个形状，只调整无障碍名称与位置。
  function setMenuIcon(open) {
    const label = open ? '返回会话' : '会话与项目列表';
    if (menu.state !== label) {
      menu.state = label;
      menu.setAttribute('aria-label', label);
      menu.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
    }
  }

  function tagHeader() {
    const corner = document.querySelector('button[aria-label="打开右侧边栏"], button[aria-label="收起右侧边栏"]');
    const header = corner ? corner.closest('header') : document.querySelector('header');
    if (header && header !== taggedHeader) {
      taggedHeader = header;
      header.setAttribute('data-dshm-header', '');
    }
  }

  // 列表页开合由脚本自己控制：只借应用的一次“展开”，之后不再点它的开关，
  // 这样点会话时不会被收起动作打断导航。
  const pageState = (${createMobilePageState.toString()})();
  let listOpen = pageState.page === 'list';
  let reexpandAt = 0;
  window.__mobileHubHome = () => {
    pageState.setPage('list');
    window.location.reload();
    return true;
  };
  // The hub can persist the exact view before reload instead of flashing the
  // list and closing it again on a delayed load callback.
  window.__dshMobilePrepareRefresh = () => {
    const page = listOpen ? 'list' : 'chat';
    pageState.setPage(page);
    return { page };
  };

  function applyListState() {
    const value = listOpen ? 'open' : 'closed';
    if (root.getAttribute('data-dshm-drawer') !== value) root.setAttribute('data-dshm-drawer', value);
  }

  function openList() {
    listOpen = true;
    pageState.setPage('list');
    applyListState();
    const expand = () => {
      if (!listOpen) return;
      const toggle = toggleButton();
      if (toggle && toggle.getAttribute('aria-label') === '打开侧边栏') toggle.click();
    };
    expand();
    setTimeout(expand, 260);
    setTimeout(applyListState, 140);
  }

  function closeList() {
    listOpen = false;
    pageState.setPage('chat');
    applyListState();
    // 新宿主的窄屏侧栏是模态导航；只藏 CSS 会让聊天区残留 inert，无法输入。
    // 会话行已延迟到导航后才调用这里，只在新版抽屉模式同步关闭宿主模态层。
    if (mobile.matches && frame?.hasAttribute('data-sidebar-drawer')
      && !frame.hasAttribute('data-sidebar-collapsed')) {
      toggleButton()?.click();
    }
  }

  // 浏览器标签与微信顶部显示的是应用标题（会话名），手机上统一显示产品名。
  const APP_TITLE = 'DeepSeek Harness';
  function pinTitle() {
    if (document.title !== APP_TITLE) document.title = APP_TITLE;
    const titleEl = document.querySelector('head > title');
    if (titleEl && !titleEl.dataset.dshmPinned) {
      titleEl.dataset.dshmPinned = '1';
      new MutationObserver(() => {
        if (document.title !== APP_TITLE) document.title = APP_TITLE;
      }).observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  }

  // HTML 附件预览：应用用 blob: 地址加 sandbox="allow-scripts" 的 iframe 展示网页。
  // iOS 的 WebKit 不让这种无源沙箱框架加载父页面的 blob 地址，手机上整片空白。
  // 父页面自己能读这个 blob，读出来改用 srcdoc 装进同一个沙箱：脚本照常运行，
  // 隔离级别不变（沙箱属性原样保留，不加同源权限）。每个 blob 只处理一次。
  function inlineHtmlPreviews() {
    for (const frame of document.querySelectorAll('[data-rightbar-col] iframe[data-html-preview][src^="blob:"]')) {
      const src = frame.getAttribute('src');
      if (frame.getAttribute('data-dshm-inlined') === src) continue;
      frame.setAttribute('data-dshm-inlined', src);
      fetch(src)
        .then((res) => res.text())
        .then((text) => {
          const zoomScript = '<script>' + ${JSON.stringify(PREVIEW_ZOOM_SCRIPT)} + '<' + '/script>';
          text = /<\\/body>/i.test(text) ? text.replace(/<\\/body>/i, zoomScript + '</body>') : text + zoomScript;
          if (frame.isConnected && frame.getAttribute('src') === src) frame.setAttribute('srcdoc', text);
        })
        .catch(() => {});
    }
    // 高度补满：从预览框顶部到屏幕底部（扣掉 Home 指示条），不依赖应用样式是否加载。
    for (const frame of document.querySelectorAll('[data-rightbar-col] iframe[data-html-preview]')) {
      const top = frame.getBoundingClientRect().top;
      if (top <= 0) continue;
      const col = frame.closest('[data-rightbar-col]');
      const safeBottom = col ? parseFloat(getComputedStyle(col).paddingBottom) || 0 : 0;
      const height = Math.max(200, Math.round(window.innerHeight - top - safeBottom)) + 'px';
      if (frame.style.height !== height) frame.style.height = height;
    }
  }

  function layout() {
    pinTitle();
    inlineHtmlPreviews();
    applyListState();
    tagHeader();
    const host = document.querySelector('[data-dshm-header]');
    if (host) {
      ensureMenu(host);
      setMenuIcon(listOpen);
      if (menu.parentElement !== host) host.appendChild(menu);
    }
    ensureBackdrop();

    const nextFrame = findFrame();
    if (nextFrame !== frame) {
      if (frame) frame.removeAttribute('data-dshm-frame');
      frame = nextFrame;
      if (frame) frame.setAttribute('data-dshm-frame', '');
    }
    if (!frame) return;

    // 新版在窄屏下动态插入 drawerMask，子元素下标不再代表侧栏/聊天区。
    // 按列身份定位；旧版没有列名时，沿实际控件向上找所属的直接子元素。
    const columnFor = (element) => {
      let node = element;
      while (node && node.parentElement !== frame) node = node.parentElement;
      return node;
    };
    const columns = [...frame.children];
    const nextSidebar = columns.find((node) => node.matches('[class*="_sidebarCol"]'))
      || columnFor(frame.querySelector('button[aria-label="新建会话"]'));
    const nextMain = columns.find((node) => node.matches('[class*="_centerCol"]'))
      || columnFor(frame.querySelector('[data-composer-seat], [contenteditable="true"]'));
    // 重新渲染/插入遮罩后摘除旧标记，避免一列同时被当成侧栏和聊天区。
    for (const node of frame.querySelectorAll('[data-dshm-sidebar]')) {
      if (node !== nextSidebar) node.removeAttribute('data-dshm-sidebar');
    }
    for (const node of frame.querySelectorAll('[data-dshm-main]')) {
      if (node !== nextMain) node.removeAttribute('data-dshm-main');
    }
    sidebar = nextSidebar;
    main = nextMain;
    if (sidebar) sidebar.setAttribute('data-dshm-sidebar', '');
    if (main) main.setAttribute('data-dshm-main', '');
    tagChrome();
    if (mobile.matches && listOpen && sidebar?.inert) sidebar.inert = false;

    // 右侧边栏（文件 / 图片 / 改动预览）：窄屏下它被挤到网格第二行、高度塌成 0，
    // 点「在侧边栏预览」看起来毫无反应。这里把它整屏显示，开关由我们自己控制：
    // 点「在侧边栏…」打开，点「收起」关闭，标签全关掉时自动关。
    const rightbar = frame.querySelector('[data-rightbar-col]') || columns.find((node) => node.matches('[class*="_rightbarCol"]')) || null;
    const rightbarTabs = rightbar ? [...rightbar.querySelectorAll('[role="tab"]')] : [];
    if (!rightbar || rightbarTabs.length === 0) root.setAttribute('data-dshm-rightbar', 'closed');
    if (rightbar) hideGuideTab(rightbar);
    const rightbarState = root.getAttribute('data-dshm-rightbar');
    if (rightbarState !== 'open') autoWrapped = false;
    if (rightbarState === 'open') autoWrapDiff();

    // 应用会在视口变化或重渲染时把侧栏收成图标条（我们把它拉满宽后会变成空白页）。
    // 以开关按钮的标签为准重新展开；连续两次都展不开就退出列表页。
    if (listOpen) {
      const toggle = toggleButton();
      if (toggle && toggle.getAttribute('aria-label') === '打开侧边栏' && Date.now() - reexpandAt > 600) {
        reexpandAt = Date.now();
        toggle.click();
      }
    }
  }

  // 标记桌面页签、统计行与保留的品牌行。
  function tagChrome() {
    if (!taggedToolbar || !taggedToolbar.isConnected) {
      const send = document.querySelector('button[aria-label="发送消息"], button[aria-label="插话发送"], button[aria-label="停止生成"]');
      const row = send ? send.parentElement?.parentElement : null;
      if (row) { row.setAttribute('data-dshm-toolbar', ''); taggedToolbar = row; }
    }
    if (!taggedCrumbs || !taggedCrumbs.isConnected) {
      const header = document.querySelector('[data-dshm-header]');
      const crumbs = header?.querySelector('[class*="crumbs"]') ?? null;
      if (crumbs) { crumbs.setAttribute('data-dshm-crumbs', ''); taggedCrumbs = crumbs; }
      const divider = header?.querySelector('span[class*="menuA"]') ?? null;
      if (divider) divider.setAttribute('data-dshm-divider', '');

    }
    if (!taggedTabs || !taggedTabs.isConnected) {
      const trail = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '轨迹');
      const row = trail ? trail.parentElement?.parentElement : null;
      if (row) { row.setAttribute('data-dshm-tabs', ''); taggedTabs = row; }
    }
    // 输入框下方的 tok/s 统计行：只在输入区里找（消息正文也可能出现 "tok/s"），
    // 以当前可见的那个为准。统计行在提问/审批卡片占用输入位时会收成 0 宽，以前
    // 一路往上找到宽度够 200 的元素，会把整个输入区（含提问卡片）标成统计行再隐藏，
    // 手机上因此无法作答；现在碰到输入区就停。
    const composerSeat = document.querySelector('[data-composer-seat]');
    const speed = composerSeat ? [...composerSeat.querySelectorAll('span')].find((el) => el.children.length === 0
      && String(el.textContent || '').includes('tok/s')
      && el.getBoundingClientRect().width > 0) : null;
    if (speed) {
      let row = speed.parentElement;
      while (row && row !== document.body && row !== composerSeat) {
        if (row.matches('[data-question-key]') || row.querySelector('[data-question-key]')) {
          row = null;
          break;
        }
        const rect = row.getBoundingClientRect();
        if (rect.width >= 200 && rect.height > 0) break;
        row = row.parentElement;
      }
      if (row && row !== document.body && row !== composerSeat && row !== taggedStats) {
        if (taggedStats && taggedStats.isConnected) taggedStats.removeAttribute('data-dshm-stats');
        row.setAttribute('data-dshm-stats', '');
        taggedStats = row;
      }
    }
    // 旧版本可能已经把标记落在输入区上；发现就摘掉，避免提问卡片被一起隐藏。
    if (taggedStats && (!taggedStats.isConnected
      || taggedStats.matches('[data-composer-seat]')
      || taggedStats.querySelector('[data-composer-seat]'))) {
      if (taggedStats.isConnected) taggedStats.removeAttribute('data-dshm-stats');
      taggedStats = null;
    }
    if (!taggedLogo || !taggedLogo.isConnected) {
      // Identify the pinned row even while its column is hidden/collapsed.
      const logo = sidebar?.querySelector('[class~="kB3qhq_logoRow"]');
      if (logo) { logo.setAttribute('data-dshm-logo', ''); taggedLogo = logo; }
    }
  }

  // 清除目标不需要另造入口：输入框上方那条「进行中的目标」自带垃圾桶按钮
  // （aria-label=清除目标），点它走应用自己的 remote.goals.clear，实测可用。
  // 之前往对话里塞的「清除目标」药丸靠 execCommand 往 Lexical 输入框写清除命令，
  // 写不进去也发不出去，点了毫无反应，所以整段删掉。

  // 捕获阶段只安排延迟关闭；工作区加号会停止冒泡，不能依赖 document 冒泡监听。
  // 应用先处理完整点击，再关闭导航抽屉；提前关闭会卸载新建按钮，打断导航。
  document.addEventListener('click', (event) => {
    if (!mobile.matches || !listOpen) return;
    const el = event.target instanceof Element ? event.target : null;
    if (el === null || !sidebar || !sidebar.contains(el)) return;
    const button = el.closest('button');
    const label = button?.getAttribute('aria-label') ?? '';
    if (button && (label === '新建会话' || label.endsWith('中新建会话') || /^(新建会话|新会话)$/.test((button.innerText || '').trim()))) {
      setTimeout(closeList, 120);
      return;
    }
    // 行右侧的操作按钮（…）属于行内控件，点它不算“打开会话”。
    if (el.closest('[class*="rowActions"]') !== null) return;
    const row = el.closest('[role="treeitem"]');
    if (row !== null) {
      if (row.hasAttribute('aria-selected')) setTimeout(closeList, 120);
      return;
    }
  }, true);

  // 点「在侧边栏查看」或消息里的文件链接（mobile.mjs 这种蓝色按钮）时，
  // 应用会先开一个标签页；等它渲染出来再把抽屉拉起来。
  (${bindPreviewNavigation.toString()})(document, root, mobile);

  // 加号会顺手把光标塞进输入框（应用自己的行为），iOS 会立刻弹出输入法。
  // 不能直接 blur——那会把刚打开的面板一起关掉；改为在按下加号的瞬间给输入框
  // 打上 inputmode=none，临时压住虚拟键盘。用户自己点输入框时再恢复。
  const composerEditor = () => document.querySelector('[contenteditable="true"]');
  let composerKeyboardMuted = false;
  document.addEventListener('pointerdown', (event) => {
    if (!mobile.matches || !(event.target instanceof Element)) return;
    if (event.target.closest('button[aria-label="添加文件或调用指令"]')) {
      const box = composerEditor();
      if (box) {
        box.setAttribute('inputmode', 'none');
        composerKeyboardMuted = true;
      }
      return;
    }
    if (composerKeyboardMuted && event.target.closest('[contenteditable="true"]')) {
      const box = composerEditor();
      if (box) box.removeAttribute('inputmode');
      composerKeyboardMuted = false;
    }
  }, true);

  // 模型菜单两级：第一级是「模型 / 推理等级」，第二级才是列表。
  // 早先为了让点开模型名直达列表，这里会用脚本替用户点一下「模型」那一行；
  // 代价是「推理等级」入口被整行跳过——手机上一辈子看不到强度档位。
  // 现在保持应用原本的两级菜单，让推理等级自己露出来。

  // 输入框里的指令 chip（/目标 等）是 Lexical 的 decorator：退格第一下只删掉自动带的
  // 空格、第二下只选中、第三下才删除，手机上的感觉就是"点了删不掉"。这里在退格后补
  // 一次判断：chip 已被选中、或输入框里只剩这条指令时，补发退格直接删掉，让一次退格
  // 就能把指令清掉，和删普通文字一致。
  const sendBackspace = (editor) => {
    // Composition may have begun during either delayed chip-deletion callback.
    if (!editor.isConnected || editor.hasAttribute('data-composer-composing')) return;
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace',
      code: 'Backspace',
      keyCode: 8,
      which: 8,
      bubbles: true,
      cancelable: true,
    }));
  };
  document.addEventListener('keydown', (event) => {
    if (!mobile.matches || event.isTrusted === false || event.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Backspace' && event.key !== 'Delete') return;
    const target = event.target instanceof Element ? event.target : null;
    const editor = target ? target.closest('[contenteditable="true"]') : null;
    if (!editor || !editor.closest('[data-composer-seat]')) return;
    setTimeout(() => {
      if (!editor.isConnected) return;
      const chip = editor.querySelector('[data-composer-command]');
      if (!chip) return;
      if (chip.hasAttribute('data-selected')) {
        sendBackspace(editor);
        return;
      }
      const rest = editor.cloneNode(true);
      for (const node of rest.querySelectorAll('[data-composer-command]')) node.remove();
      if ((rest.textContent || '').trim() !== '') return;
      sendBackspace(editor);
      setTimeout(() => {
        if (editor.isConnected && editor.querySelector('[data-composer-command]')) sendBackspace(editor);
      }, 40);
    }, 30);
  }, true);

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; layout(); });
  };

  const start = () => {
    layout();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    setInterval(layout, 2000);
    mobile.addEventListener('change', schedule);
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('orientationchange', schedule, { passive: true });
  };

  root.setAttribute('data-dshm-mobile', '');
  applyListState();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
`;

/** 注入脚本与样式的版本号：内容一变，手机地址就变，避免内置浏览器复用旧缓存。 */
export const SHELL_VERSION = (() => {
  const text = MOBILE_CSS + MOBILE_SCRIPT;
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(31, hash) + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
})();

/** 注入手机壳脚本与样式，返回新的 HTML。 */
export function injectMobileShell(html) {
  const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />';
  let output = html;
  // Apply mobile CSS during parsing, before the module renderer's first commit.
  output = output.replace(/<html\b(?![^>]*\bdata-dshm-mobile)[^>]*>/i, (tag) => tag.replace(/>$/, ' data-dshm-mobile>'));

  if (/<meta[^>]+name="viewport"[^>]*>/i.test(output)) {
    output = output.replace(/<meta[^>]+name="viewport"[^>]*>/i, viewport);
  } else if (/<head[^>]*>/i.test(output)) {
    output = output.replace(/<head[^>]*>/i, (match) => `${match}${viewport}`);
  }

  if (!output.includes('id="dshm-loading"')) {
    output = output.replace(/<body[^>]*>/i, (tag) => `${tag}<div id="dshm-loading" role="status" aria-live="polite">正在加载…</div>`);
  }

  const head = `<style id="dshm-mobile">${MOBILE_CSS}</style>`;
  output = /<\/head>/i.test(output)
    ? output.replace(/<\/head>/i, `${head}</head>`)
    : `${head}${output}`;

  const script = `<script id="dshm-mobile-shell">${MOBILE_SCRIPT}</script>`;
  output = /<\/body>/i.test(output)
    ? output.replace(/<\/body>/i, `${script}</body>`)
    : `${output}${script}`;

  return output;
}
