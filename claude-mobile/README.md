# 手机连接：Codex / DSH / Claude

> 合仓子包：源码位于仓库内 `claude-mobile/`。安装及部署由根项目统一协调；迁移时保留原 Application Support 私有状态。独立测试、CI 与本机资源边界见 [TESTING.md](TESTING.md)。

`/m/` 使用同一隧道与三个页签。Codex、DSH 继续使用原来的桌面连接；Claude 的消息投递给 Claude Desktop 正在运行的同一条原生会话，不运行独立 `claude -p` 回合，也不另起会话兜底。

## Claude 的发送流程

1. 客户端为每条消息生成稳定 UUID，网关先原子保存命令指纹和状态。
2. 新会话仅用官方 CLI 的本地 `/model` 命令生成初始化记录；要求零费用、零模型用量、无工具执行。它不承载真正的用户消息。
3. 等创建进程真实退出、释放 writer，再用官方 `claude://resume?session=...` 导入桌面。
4. 通过 `cliSessionId` 查桌面实际会话 ID，并确认活跃进程的 entrypoint 和 hostSessionId 匹配。不能直接拼接桌面 ID，也不能 fork 到另一份历史。
5. 消息投递给这个桌面 owner 的原生 peer socket，`msg_id / uuid` 使用同一稳定请求 ID。`priority: now / next` 分别对应原生队列的插入与排队。
6. 只有原生 JSONL 中出现对应 user UUID 才标记 accepted；socket write、HTTP 200、深链打开成功都不能代替接收证明。
7. 回复独立读取原生 JSONL。POST 连接断开时查询原 requestId，不换通道、不自动重发。网关重启后 dispatched 变为 unknown，并继续核对历史；尚未投递的 prepared 明确标为未发送，可保留原会话重试。

游标使用原生 JSONL 的记录序号（seq），不用时间戳；同一毫秒写入的多条记录也不会漏。手机轮询、刷新和重连读取的是同一份桌面历史。

**已知语义差异**：peer 协议会在原生记录里把消息标成 “Another Claude session sent a message”，桌面 UI 和模型都按“另一个 Claude 会话”处理，而不是用户本人键入。实测模型会因此拒绝执行某些长输出请求。当前没有找到可外部调用的“以用户身份注入”接口；App 内部的 SDK `prompt.submit` 是 stdio 私有通道。这个差异不能用辅助功能或模拟键入绕过。

**展示修复已撤回**：此前给正文增加 `cross-session-message` 封套，虽然能隐藏英文说明，却使本人的消息默认折叠进活动记录，不能满足正常聊天要求。发送器已恢复直接发送原文；手机保留读取这批历史封套的兼容。桌面英文说明暂未解决，也尚未接通真正的原生用户发送入口。不得把手动展开或 verbose 模式当成两端正常消息一致的验收通过。

## 图片的真实边界

桌面 App 在本地 Code 会话里发图走 App 内部 SDK 的 `prompt.submit` 图像附件通道；这不是外部进程可调用的接口。Claude Code 的本地 peer 帧只接受字符串 `message.content`；它的 `file_attachments` 受 `tengu_send_file` 特性开关控制，本机实测为关闭：CLI 静默忽略，spool 文件不消费，transcript 不出现 `@"..."` 前缀，也没有附件块。

因此当前实现同时做两件事：

- 把手机图片按原生 `file_attachments` 描述符投递（开关打开时就是真实附件）；
- 在消息正文里附加一段仅用于兼容的 Read 路径说明，保证开关关闭时桌面模型仍能读取图片。

accepted 后网关会读取原生记录，返回 `attachmentDelivery`：`native` 表示桌面确实做了原生附件材质化，`read-path` 表示桌面只收到文件路径、由模型用 Read 读取。手机在消息下方明确显示“电脑端已收到消息，并以文件读取图片（非原生附件）”，不把 Read 当成附件对齐。真实截图已用这条路径识别通过；纯色合成图可能因模型视觉能力被误判，不属于投递链路的成功证明。

旧实现会改写 `~/.claude/settings.json` 增加手机上传目录的 Read 规则。该写入模块已删除；本机已有的 `Read(/$HOME/ClaudeMobile/uploads/**)` 规则是旧验收留下的，仅被上述 Read 兜底使用，不影响其他设置。

## 状态与控制

- `POST /claude/api/chat`：JSON 请求，必须有 `requestId`；返回 accepted、waiting/unknown 或 rejected。
- `GET /claude/api/command/{requestId}`：核实原请求，查询无发送副作用；包含 `attachmentDelivery`。
- `GET /claude/api/session/{sessionId}`：原生历史、消息游标和桌面连接状态。
- `POST /claude/api/read`：手机实际加载当前回复后，以稳定请求编号确认原生已读。先核对 CLI 与桌面会话映射、回复和原生状态版本，再通过 App 的 `claude://resume` 入口打开同一会话；只有重新读取原生未读状态为 false 才返回 verified。这个操作会让电脑跟随到相应会话。原生状态落盘有延迟时返回 pending，复核只查询同一条命令，不再次打开会话。手机不保存本地已读遮罩。
- `priority: now / next`：原生 peer 仍支持插入和排队；手机界面不再显示这两个按钮，默认一律发 `now`（插入），脚本也可继续传 `next`。
- peer 的 `from_mode` 按目标会话匹配：目标 `bypassPermissions` 时发 `bypass`，其余发 `prompting`。否则跨会话策略会把手机消息挂起等桌面批准，表现为手机一直待确认。
- 目标会话忙碌时，网关保持 `dispatched/waiting`，不把排队中的消息误标为 unknown，也不自动重发；未知结果只提供“重新发送”（新请求编号），由用户决定。

已确认没有可直接调用的桌面接口：

- **暂停/停止当前任务**：peer control 只处理 `rename / peer_message_status / notify_when_idle / peer_idle_* / artifact_*`，没有 interrupt；App 的 SDK `control_request` 是内部 stdio，不暴露本地 socket。禁止用 SIGINT、杀进程、新 prompt 或辅助功能点击冒充停止。
- **会话中切换模型**：没有外部接口。新会话创建时手机可以表达模型意图，但桌面导入后以桌面当前模型为准；实测请求 `jd2/DeepSeek-V4.1-Flash-a[1m]`，桌面实际为 `jd/DeepSeek-V4.1-Flash-A-joybuilder[1m]`。
- **会话中调整权限**：同上。实测新会话请求 `acceptEdits`，桌面实际为 `default`。

因此手机只在新建时显示模型/权限意图，进入会话后明确提示“由电脑端会话决定”；没有暂停按钮，也没有伪装的控制路由。插入和排队仍可用。

## 已移除的旧控制组件

`手机连接控制.app`、它的 LaunchAgent、安装脚本、辅助功能授权引导和 `backend/native/control-host.mjs` 已不在运行路径；源码目录中只有 `.backup/retired-desktop-control-20261113-110254/` 归档，`~/Applications`、`~/Library/LaunchAgents` 和 `~/Library/Application Support/ClaudeMobile/` 中没有该 App、控制 socket 或后台进程。当前实现不依赖辅助功能、模拟点击或窗口位置。

## 界面

- 顶部薄胶囊切换保留在全屏文件预览外。
- 基础背景、排版、文件夹开合图标、缩进、独立添加按钮按 Codex 统一；DSH 保留原生事件。
- Claude 过程区按时间顺序显示；轻量菜单、原位待办，不使用遮罩抽屉。
- 不显示“电脑正在回复”状态行，也不显示插入/排队或“查询状态”按钮；发送默认插入。正常等待由后台轮询完成。
- 模型菜单的布局为内容自适应、受手机视口限制；会话内模型/权限只显示“由电脑端决定”。

## 运行与凭据

```sh
node scripts/install.mjs
node scripts/status.mjs
```

LaunchAgent 为 `com.wengqiang.claude-mobile`，端口 18903。统一二维码仍使用桌面“手机连接”入口。访问口令、命令记录、桌面接管 intent、上传文件和日志保存在 `~/Library/Application Support/ClaudeMobile/`，不写入源码或网页。

重启网关不应结束由 Claude Desktop 持有的实际回合。运行前必须确认 `node --test test/*.test.mjs` 通过；真实桌面接管、图片和断线恢复需要另作链路验收。浏览器手机视口检查不等于 iPhone 真机验收。

## 2026-11-13 验收记录

已在独立测试网关（18904，同一源码、独立 state）和真实手机页面（390×844 视口）验证：

- 手机新建会话：桌面出现 `entrypoint=claude-desktop-3p` 的同一会话，用户 UUID 一致，回复可见。
- 续聊、重复提交同一 requestId：原生 user UUID 只有一条，查询返回 accepted。
- 手机 UI 实际发送、刷新恢复：同一会话、同一消息，无重复气泡；桌面回复在 1.5 秒轮询内出现。
- 桌面侧 peer 消息进入同一会话后，手机无刷新即可看到消息和回复。
- 仅图、图文、多图：桌面收到带 Read 路径的消息，模型逐张 Read 并回复；真实手机截图识别正确；`attachmentDelivery` 明确为 `read-path`。
- 插入/排队（API）：长回合运行中发送 `now` 和 `next`，两条消息均进入原生队列并按插入、排队顺序得到回复；手机界面已按用户要求去掉这两个按钮，默认 `now`。
- 新建时请求的模型/权限未生效，桌面实际值以 desktop 元数据为准，已在能力中标注。

18903 常驻服务现已更新并通过真实入口回归。补充原生已读验收：电脑将测试会话标为未读，手机展示圆点；手机打开后的同一请求令原生状态变为已读，经公网复核返回 verified=true，电脑圆点清除。测试入口和需要单独启用的浏览器验收见 [TESTING.md](TESTING.md)。

尚未完成：iPhone Safari 真机；Mac 人工键入一条消息的端到端；原生附件开关打开时的 `native` 分支；暂停/会话内切模型/调权限（无接口）。peer 消息来源语义仍有上述差异，不能声称与桌面键入完全等价。
