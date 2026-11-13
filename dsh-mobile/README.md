# DSH 手机连接

> 合仓子包：源码位于仓库内 `dsh-mobile/`。安装及部署由根项目统一协调；迁移时保留原 Application Support 私有状态。独立测试、CI 与本机资源边界见 [TESTING.md](TESTING.md)。

手机版使用独立固定的页面和手机模块清单，继续访问电脑端的同一份会话、历史和任务。
手机不启动桌面动态插件加载器，不订阅桌面动态插件库存，也不加载桌面安装的本地界面扩展。
**用户要求手机功能保持现状，不跟随电脑 DSH 更新。** 电脑升级不会替换 `frontend/` 中的资源；
手机端已关闭前端热更新，不从桌面补取缺失的静态代码。

本模块位于统一仓库的 `dsh-mobile/`。手机使用 `/m/` 统一页面，DSH 子页面仍挂在同一域名的 `/dsh/` 下；与 Codex、Claude 共用一条隧道。

日常入口：打开桌面「手机连接」文件夹，用手机扫描 **手机连接.png**，再在顶部选择 DSH。二维码和状态自动更新。电脑需保持联网、不睡眠。

## 截图

| 旧网关页（历史截图） | 手机：会话 | 手机：列表页 |
| --- | --- | --- |
| ![](docs/screenshots/panel.png) | ![](docs/screenshots/phone-conversation.png) | ![](docs/screenshots/phone-list.png) |

手机端只有两个页面：**会话页**（整屏对话，左上角返回）和**列表页**（整屏的项目 + 会话列表）。
桌面端的侧边栏图标轨道、页签（对话/轨迹）、tok/s 与缓存统计、访达/右侧面板等控件在手机上都会隐藏。
图片与 HTML 附件预览支持单指拖动、双指缩放和双指平移。HTML 缩放范围 20%～400%；图片可缩小到 5%，保留原百分比/加减/适应宽度控件。缩放只作用于预览内容，原文件和 iframe 沙箱权限保持不变。

## 它是怎么工作的

```
手机 → 免费隧道 https://<域名>:<端口>/dsh/   （Codex 手机连接用的同一条）
     → 本机 18902  DSH 手机网关（口令 + 手机排版）
     → 本机 Harness 网页服务 127.0.0.1:<随机端口>（注入签名 cookie）
```

三点设计取舍：

1. **固定手机界面与模块集合。** `frontend/` 保留已验证快照；`backend/mobile-modules.json`
   明确列出手机使用的 50 个模块。`mobile-profile.mjs` 只从本地快照组合这些模块，并校验依赖；
   启动、安装和电脑更新均不重新捕获资源。聊天、历史、附件预览、模型选择和审批仍保留；
   桌面插件管理、动态插件加载、本地侧聊/批注、桌面终端等 26 个模块不进入手机启动包。
   固定代码支持 Brotli/gzip 压缩和私有浏览器缓存；入口 HTML 始终重新读取。
   只有 API 和 WebSocket 继续转发给桌面宿主，保持数据同步。
2. **不猜端口。** 桌面端用 `--port 0` 启动，端口每次都不一样。网关从 Harness 宿主进程
   的监听表里读出端口，并用「未认证 401 + 固定提示语」确认身份，之后每 10 秒复核一次。
3. **不另开隧道。** 根目录的 `connection/ingress.mjs` 增加了一条 `/dsh/*` 转发到
   127.0.0.1:18902 的路由，与 Codex、Claude 共用同一张统一二维码。

## 目录

| 路径 | 内容 |
| --- | --- |
| `backend/server.mjs` | 手机网关：口令、`/dsh` 前缀、状态与二维码、上游发现 |
| `backend/proxy.mjs` | HTTP / WebSocket 反代，改写 Host、Origin、Cookie |
| `backend/dsh-auth.mjs` | 用 `$DSH_HOME/.credentials.yaml` 里的密钥签浏览器 cookie |
| `backend/upstream.mjs` | 发现 Harness 网页端口（进程监听表 + 探测） |
| `backend/mobile.mjs` | 注入手机排版：整屏列表、安全区、输入框字号 |
| `backend/frontend.mjs` | 固定资源服务；缺失资源返回 404，不跟随桌面升级 |
| `backend/mobile-profile.mjs` / `mobile-modules.json` | 独立手机模块清单、依赖校验和本地组合 |
| `frontend/` | 独立保存的手机界面和插件快照，禁止自动更新 |
| `scripts/install.mjs` | 安装/更新 LaunchAgent 并等待就绪 |
| `test/` | 单元 + 端到端测试（假上游，不碰真实 Harness） |

访问口令与日志都在 `~/Library/Application Support/DshMobile/`，不进源码目录：

- `access-token`：手机链接里的随机口令（32 字节 base64url，权限 600）。
- `dsh-mobile.log` / `dsh-mobile.error.log`：LaunchAgent 输出。

## 使用

启动 / 更新（会重装 LaunchAgent 并接管自启）：

```sh
cd "$HOME/mobile-chats"
npm run install:local
npm run status
npm --prefix dsh-mobile test
```

手机地址形如 `https://<隧道域名>:<端口>/dsh/?t=<口令>`，第一次打开会换成
`dshm-auth` cookie 再跳到 `/dsh/`。二维码以桌面「手机连接」文件夹中的最新图片为准。

## 与 Codex 手机入口的关系

- 隧道、证书、域名的生命周期都归 仓库的 `connection/`；它的连接服务停掉，Harness 的公网
  入口也就没了（本机与局域网地址不受影响）。
- 两侧口令互相独立：Codex 的配对密文在 URL 的 `#` 后面，Harness 用 `dshm-auth` cookie。
- 修改 根目录 `connection/ingress.mjs` 后需要重新安装它的连接服务：

  ```sh
  cd "$HOME/mobile-chats" && npm run install:local
  ```

## 访问控制

- 手机侧只认 `dshm-auth` cookie；没有它先拿到 401，`?t=` 口令错也是 401。
- 网关默认监听 `0.0.0.0:18902`，因此同一局域网可直接访问；公网必须经隧道。
- 转发到 Harness 时会注入由本机密钥签名的 `dsh-auth-*` cookie，密钥只从
  `$DSH_HOME/.credentials.yaml` 读取，不写日志、不进命令行参数。
- 状态接口 `/_dsh/status` 只接受本机回环请求，且拒绝带转发头的调用。

## 已知限制

- 隧道地址由免费隧道服务决定，重启后可能变化，请以最新二维码为准。
- 手机界面已固定，但仍共享桌面宿主的 API。未来若桌面升级破坏接口兼容，需修复
  网关兼容层；这不等于手机界面需要升级，也不能保证任何未来后端版本都永远兼容。
- 仅在用户明确授权升级手机版时，才可重新准备 `frontend/public/` 并执行
  `node scripts/pin-frontend.mjs --replace`；不要加入启动、安装或定时任务。
- 手机上是同一个网页客户端，因此和桌面浏览器一样需要 Harness 处于运行状态；
  Harness 退出后页面会提示「未在运行」，重新打开后刷新即可。
- 没有推送通知；后台任务结束后需要回到页面查看。

## 排错

| 现象 | 处理 |
| --- | --- |
| 二维码显示「服务未就绪」 | `node scripts/status.mjs`，再 `node scripts/install.mjs` |
| 手机扫码后 401 | 口令过期或链接来自旧二维码，扫桌面文件夹中的最新码 |
| 手机页面 503「Harness 未在运行」 | 打开 DeepSeek Harness，稍等或刷新 |
| 公网打不开、内网正常 | 共享隧道尚未就绪：在仓库根目录运行 `npm run status` |
| 想看网关日志 | `tail -f "~/Library/Application Support/DshMobile/dsh-mobile.log"` |

## 未改动的东西

没有修改 Harness 自身、模型网关的模型路由、Codex 的配对逻辑；只是在
根目录 `connection/` 增加了一个转发模块并在 ingress 里挂了一条子路径路由。

## 刷新后保持手机页面

手机壳通过 `backend/page-state.mjs` 按标签页保存列表/会话状态，独立于桌面侧边栏开关；只在用户打开列表或进入会话时写入，初始化、后台切换与重连不会覆盖它。状态保存在 sessionStorage，并由当前 history entry 兜底；会话本身继续使用原有经过验证的会话恢复流程。

首次加载这一版后切换一次页面即可建立记录。验证覆盖列表页与原会话各连续刷新 3 次，列表从首帧即保持打开，没有先显示会话再返回列表。新增状态回归后 `npm test` 共 69 项通过。
