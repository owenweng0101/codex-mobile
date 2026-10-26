# 第三方来源

## ZCode

上游项目：https://github.com/zai-org/ZCode ，采用 Apache-2.0，部分 RPC 基础代码另有 MIT 来源声明。当前手机界面兼容目标是公开网页版本 3.16.3。

本项目复用手机网页 UI、RPC 传输格式、命令 schema 与控制器投影。**使用者不需要安装、运行或登录 ZCode。**

`third-party/zcode-rpc/src/` 随仓库提供 8 份未经修改的 RPC 源文件，固定于上游提交 `3c5b227649371507ddc4eb46ac5133afe6db1cab`。来源路径、提交和逐文件 SHA-256 记录在 `source.json`。上游 Apache-2.0 许可证、声明及其记录的 VS Code MIT 许可证一并保留。`entry.ts` 是本项目的导出入口；`scripts/build-rpc.mjs` 校验源文件后，用 esbuild 生成本地运行时。`npm ci` 自动执行该构建，不访问本机应用安装目录。

该开源快照的 RPC 早于当前网页版本；`adapter/rpc-server.mjs` 的派生类补充事件订阅失败响应（205），避免未开放事件导致整个连接关闭。上游源文件保持不变，兼容行为由连接回归测试与实际网页验证。

`scripts/import-zcode-ui.mjs` 从 `https://zcode.z.ai/remote/v4/3.16.3/` 自动下载固定版本的网页资源并生成命令 schema。完整网页构建产物、生成的命令 schema、RPC bundle 和修改后的 UI bundle 均在 Git 忽略目录中。准备过程需要网络；下载资源不可用时会报错，不会转而读取本机 ZCode。

`adapter/frontend-stage/build-compat.mjs` 对固定构建做可复现的精确替换：暴露挂载接口、注入 Codex 数据与模型目录、适配草稿导航、图片与历史行为、隐藏不适用的第三方账号入口。预期片段匹配失败时停止，避免悄悄套用到不兼容版本。补丁清单与校验值在本机生成。

`adapter/read-services/original-controller-source.txt` 是少量保留的上游控制器投影代码，来源归属 ZCode，使用 Apache-2.0；周边模块提供本机 Codex 数据适配。参见 NOTICE 与 LICENSE。

## 其他依赖

ws、qrcode、marked、DOMPurify、xterm、@iarna/toml 等通过 npm 安装，各自许可见对应包。浏览器所需的 npm 构建文件在本机准备，不提交到 Git。frpc 是使用者从樱花官方单独取得的客户端，仓库不包含其二进制或访问密钥。

本项目不包含 Codex CLI、Codex 桌面应用或模型账号凭据。
