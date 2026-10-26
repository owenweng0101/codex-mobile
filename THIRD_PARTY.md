# 第三方来源

## ZCode

上游项目：https://github.com/zai-org/ZCode ，采用 Apache-2.0。当前兼容目标是官方桌面发行版 3.16.3 及其公开网页资源。

本项目复用手机网页 UI、RPC 传输格式、命令 schema 与控制器投影。`scripts/import-zcode-ui.mjs` 从用户自己安装的 ZCode 3.16.3 导入两份 RPC 运行时，并从 `https://zcode.z.ai/remote/v4/3.16.3/` 下载版本固定的网页资源。

这些完整构建产物、导入的第三方命令 schema 和修改后的大体积 UI bundle 均在 Git 忽略目录中，**不作为本仓库源码提交**。使用者需自行取得相应上游资源，遵守上游及其依赖的许可。ZCode 不需要运行或登录。

`adapter/frontend-stage/build-compat.mjs` 对固定构建做可复现的精确替换：暴露挂载接口、注入 Codex 数据与模型目录、适配草稿导航、图片与历史行为、隐藏不适用的第三方账号入口。预期片段匹配失败时停止，避免悄悄套用到不兼容版本。补丁清单与校验值在本机生成。

`adapter/read-services/original-controller-source.txt` 是少量保留的上游控制器投影代码，来源归属 ZCode，使用 Apache-2.0；周边模块提供本机 Codex 数据适配。参见 NOTICE 与 LICENSE。

## 其他依赖

ws、qrcode、marked、DOMPurify、xterm、@iarna/toml 等通过 npm 安装，各自许可见对应包。浏览器所需的 npm 构建文件在本机准备，不提交到 Git。frpc 是使用者从樱花官方单独取得的客户端，仓库不包含其二进制或访问密钥。

本项目不包含 Codex CLI、Codex 桌面应用或模型账号凭据。
