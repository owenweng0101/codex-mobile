# 桌面统一二维码维护

这里是原 `~/Library/Application Support/MobileQR/{status,update}.mjs` 的可维护源码。运行时从本仓库加载连接状态读取模块，路径均基于仓库位置或当前用户主目录计算，不包含个人绝对路径和真实凭证。

输出目录固定为当前用户的 `~/Desktop/手机连接/`，只生成：

- `手机连接.png`：统一三 tab 入口，包含访问凭证，权限 600。
- `连接状态.txt`：入口及 Codex、DSH、Claude 可用状态，不包含地址或 token，权限 600。

旧 `Codex 手机连接.png`、`DSH 手机连接.png` 每次都会清除。统一入口离线、状态读取失败或图片损坏时，移除失效统一码，写入状态说明；恢复后生成新统一码。其他用户文件不删除。LAN-only 状态继续提供一张局域网统一码。某一个电脑端未就绪不妨碍使用其他可用 tab。

## 测试

```sh
node --test desktop/mobile-qr/*.test.mjs
```

测试只使用临时主目录、程序生成的假凭证和 PNG、假状态传输以及假 LaunchAgent 命令，不读取本机真实 token，不操作实际服务，不保存验收回执或真实鉴权响应。

如需接入根目录的测试入口，将 `desktop/mobile-qr` 纳入其测试目录列表。模块不依赖额外 npm 包；`status.mjs` 通过相对导入复用 `connection/control-client.mjs`。

## 安装 QR 定时任务

在仓库根目录运行：

```sh
# 默认及此选项均只预览，无文件写入和服务操作：
node desktop/mobile-qr/install.mjs --dry-run

# 由统一部署流程显式执行：
node desktop/mobile-qr/install.mjs --apply

# 安装器也接受另一检出目录，路径可含空格：
MOBILE_CHATS_ROOT="/absolute/path/to/mobile-chats" node desktop/mobile-qr/install.mjs --apply
```

仅安装/替换 `com.wengqiang.mobile-qr`，每 60 秒检查一次，并在登录或加载任务时立即检查；减少无必要的后台唤醒，不影响聊天连接。生成的 LaunchAgent 直接执行选定仓库的 `desktop/mobile-qr/update.mjs`，保留当前 Node 可执行路径，并设置 `MOBILE_CHATS_ROOT`；仓库应位于用户稳定可读的位置，移动后重新安装。

安装器只处理自己的标签、plist 及 QR 错误日志目录；不会安装、停止、重启 Codex、DSH、Claude 或隧道，不读取/复制任何凭证。`RunAtLoad` 会在真正安装后触发一次二维码更新，因此未授权部署时不要执行 `--apply`。

生成位置：

- LaunchAgent：`~/Library/LaunchAgents/com.wengqiang.mobile-qr.plist`
- 错误日志：`~/Library/Application Support/MobileQR/error.log`

不要将机器生成的 plist、错误日志、二维码、状态响应或本机 `*-receipt.json` 放入公开提交。

## 原状态接口的迁移

保持 `readMobileStatus`、`readDshStatus`、`readClaudeStatus`、`isLocalMobileRequest` 导出，供其他维护脚本迁移引用。共享连接仍通过私有 Unix socket 读取；网关状态仅允许回环 HTTP，公开地址必须通过同源、协议、路径和口令格式校验。

其他模块如仍引用旧 Application Support `status.mjs`，应改为相对于自身的新仓库导入，再删除旧模块；不能提前删除仍被调用的状态模块。

## 可退役清单与顺序

由根目录统一迁移流程实施，本模块不自动执行这些删除：

1. 将所有其他调用方的旧 `MobileQR/status.mjs` 导入迁到本模块。
2. 通过上述安装器将现有 QR LaunchAgent 改为执行本仓库脚本，验证统一在线/离线/恢复三态及定时更新。
3. 确认不再有旧调用方后，可删除 `~/Library/Application Support/MobileQR/update.mjs` 和 `status.mjs` 两个旧源码副本。保留日志目录和新的 QR LaunchAgent。
4. 旧桌面双码由新 updater 自动清除，离线也不恢复；无需保留旧码文件或另一个二维码服务。
5. `connection/打开国内扫码.command` 保留为统一打开入口的兼容跳转。单组件旧启动/停止/更新脚本由根目录统一维护入口接管后退役，不由 QR 模块删除。

不能退役统一入口所需的 8787/8796/8797/18902/18903 服务，也不能删除会话、上传文件、认证/隧道配置或原生桌面宿主。
