# 手机连接：Codex / DSH / Claude

电脑上保留一个「手机连接」文件夹和一张 `手机连接.png`。手机扫码后，在同一页面顶部切换 Codex、DSH、Claude，继续访问电脑上的会话。电脑需要保持开机联网，各桌面客户端按需运行。

本仓库沿用原 `owenweng0101/codex-mobile` 的地址和提交历史，现统一维护三个手机模块、共享外网入口与桌面二维码更新程序。它是个人开发的兼容项目，不属于 OpenAI、DeepSeek 或 Anthropic 官方产品。

## 代码与入口

| 路径 | 职责 |
| --- | --- |
| `backend/` | Codex 本机 API 与桌面会话连接 |
| `adapter/` | Codex 固定手机版界面、RPC、附件与历史适配 |
| `connection/` | 三个模块共用的隧道与 HTTP/WebSocket 入口 |
| `dsh-mobile/` | DSH 手机网关、固定模块清单与手机交互 |
| `claude-mobile/` | Claude 手机网关、原生历史及 `/m/` 三入口页面 |
| `desktop/mobile-qr/` | 一张统一二维码及状态文件的维护程序 |
| `scripts/` | 统一启动、停止、安装、状态与测试命令 |

本机统一源码建议放在 `~/mobile-chats`。各组件的凭证、运行状态和日志位于当前用户的 Application Support 或私有 `runtime/`，不提交到 Git。Codex 的已安装运行副本仍由安装器维护；它们是部署产物，不是另一套开发仓库。

旧的独立扫码页与双码回退已退役。统一入口离线时只显示不可用状态，不重新生成 Codex、DSH 两张码。三个 tab 使用的内部聊天适配器仍需运行，不能因页面合并就把它们删除。

## 已配置电脑上的维护

需要 Node.js 24+、macOS，以及现有桌面客户端和隧道配置。Python 文件解析需要 `requirements-dev.txt` 中的依赖；可通过 `CODEX_MOBILE_PYTHON` 选择已配置的 Python。

```sh
npm ci
npm run prepare:ui
npm test
npm run check:public
npm run status
```

`prepare:ui` 从 ZCode 官方公开地址准备固定 3.16.3 网页资源；无需安装或登录 ZCode。生成的完整第三方构建不提交到 Git。

统一维护命令：

```sh
npm start                    # 启动已安装组件，保留已经运行的进程
npm run status               # 查看六个内部组件状态，不显示凭证
npm run install:local -- --check  # 安装前检查，不停止服务
npm run install:local         # 更新适配器、隧道、DSH、Claude 与统一 QR
npm stop                     # 停止手机访问组件，默认保留 Codex 后端
```

更新 Codex 后端必须显式使用 `--codex-backend`，并通过现有任务／终端维护检查；有本项目持有的任务或终端时拒绝更新。上述安装器面向已经配置好的本机环境，不会创建模型账号、隧道账号或私钥。首次部署前须准备自己的运行配置和认证资料，不能直接复制其他电脑的 Application Support。

DSH 的手机资源保持固定。迁移现有安装时复制已经审核的 `dsh-mobile/frontend/` 本机快照；没有完整快照时不能启动 DSH 手机界面。安装、启动、CI 和定时任务都不会自动抓取桌面资源。资源与测试边界见 [DSH 测试说明](dsh-mobile/TESTING.md)。

旧 Codex、DSH 和 Claude 手机文档地址统一跳转到 `/m/`，不再作为独立手机页面。跳转会清掉旧地址中的 query/hash；没有统一入口登录状态时，需要重新扫描桌面统一二维码。统一页内的三个 iframe 继续使用各自认证，不把旧模块口令转换成统一入口权限。

桌面二维码更新任务直接从本仓库执行，每 15 秒检查一次；内容不变时不重写文件。访问码只在本机私有文件和鉴权链路内使用。请私下保管二维码。

## 手机体验

- 同一二维码、同一顶部切换入口；列表和会话保留各自阅读位置。
- 三个输入框均固定为空内容时的高度，长文本只在框内滚动，不随字数撑高。
- 图片及文件使用整页预览，支持已经实现的缩放、滚动及返回；手机浏览器和不同文件类型的具体边界见各模块说明。
- DSH 手机界面和模块集合不会跟随桌面更新，也不加载本机侧聊、批注等桌面扩展。

## Claude 当前限制

Claude 的消息与回复进入同一桌面会话，但发送仍使用原生 peer 通道，来源语义尚不等同于用户在桌面输入框键入。桌面英文说明尚未解决；曾导致本人消息默认折叠的封套方案已撤回。不能把点开展开或隐藏消息当作正常聊天一致性的修复。

部分图片通过模型 Read 文件路径交付，不能宣称是原生图片附件。原生已读确认依赖桌面状态回读，可能有延迟，并会让电脑跟随到相应会话。没有修改或重签名官方应用，也没有改写原生会话数据库。

## 测试与发布

```sh
npm test
npm --prefix dsh-mobile run test:pinned  # 本机完整固定资源验收
npm run check:public
```

根测试覆盖 Codex、DSH、Claude、统一服务管理和 QR。公开 CI 不带 DSH 完整构建，相关 11 项资源测试会明确跳过，其余源码与协议测试照常运行；本机发布前另跑完整 pinned 模式。Claude 的四项 Ego 浏览器测试需显式启用，见 [Claude 测试说明](claude-mobile/TESTING.md)。浏览器手机尺寸验证与实体手机验收分别报告。

发布前检查 staged 文件，不包含聊天记录、上传文件、二维码、私有配置、运行回执或本地插件构建。推送后核对精确提交 SHA 的 GitHub CI；本地测试通过不等于远程发布验收通过。

## 架构与第三方

共享链路和必须保留的后台见 [架构说明](docs/architecture.md)。上游来源、固定资源和许可证见 [THIRD_PARTY.md](THIRD_PARTY.md)。运行配置示例在 `examples/`；不要把真实凭据写入源码或示例。
