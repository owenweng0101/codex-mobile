# DSH Mobile maintenance

- 用户要求手机版固定功能和界面，不随电脑 DSH 更新。生产默认必须使用 frontend/ 中的固定资源，不可自动重新捕获或回退到桌面静态资源。
- 不得在启动、安装、定时任务里调用 scripts/pin-frontend.mjs。只有用户明确要求升级手机版时，才能评审并更新 frontend/，该脚本需显式 --replace。
- 会话、任务、文件、模型接口及 WebSocket 继续连接正在运行的桌面宿主，保持同一份数据。若未来后端协议变化，优先改兼容层，不主动升级手机界面。
- 不启动第二个共享同一数据库的 DSH 宿主。不要修改桌面程序、用户会话数据库或 Codex Mobile 隧道来修手机样式。
- 窄屏宿主会插入 data-sidebar-mask，禁止用 frame.children 的固定下标定位列。
- 检查：npm test；真实网页在手机宽度验证列表铺满、会话打开及返回。部署仅重启 com.wengqiang.dsh-mobile。

- 手机启动模块以 backend/mobile-modules.json 为显式白名单；不得随桌面插件清单自动扩展。禁止恢复桌面动态插件加载器、插件库存订阅及 @local 界面插件。会话数据及服务端工具仍与桌面共享。修改白名单必须验证依赖闭合、聊天/附件/模型/审批，并通过真实手机宽度验收。
- 手机附件预览固定为单栏；旧分栏恢复时保留全部文件标签与当前文件，禁止标签拖动分栏，保留每个标签的关闭按钮。不得只隐藏分栏按钮而保留分栏状态。
- 会话列表必须区分点击与滚动，不得在 pointerup 后无条件补发点击。新建入口在捕获阶段仅安排延迟收起，避免阻断原生导航，并覆盖会停止冒泡的工作区加号。更新时间与操作按钮保留间距。

## Source-only CI

- Keep all pinned integration tests. Missing ignored frontend assets must produce explicit SKIP reasons; never download/capture a desktop build in CI.
- `npm run test:pinned` requires the complete reviewed local snapshot and must fail if it is missing.
- Default tests use isolated mock upstreams and must not require or start a desktop host.
