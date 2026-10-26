# 公网中转与免费候选方案

核对日期：2026-10-26。价格、额度、认证要求和网络可达性都会改变；以各平台当期规则为准。

## 当前实际接入：樱花 SakuraFrp

当前启动器只负责管理樱花的 frpc。使用 TCP 隧道、免费 nyat.app 域名与证书、自动 HTTPS。真实开发环境完成了有效 TLS 证书验证、实例身份校验、WebSocket 二进制往返、浏览器配对和项目列表加载。微信实机发现的入口来源校验问题已修复，仍需持续收集手机兼容性反馈。

免费账户官方额度：2 条隧道、10 Mibps、每月 5 GiB，签到可补充流量。实际控制台要求实名才能创建隧道和使用子域绑定；这不是本项目能代办的权限。证书与域名按[官方操作流程](https://doc.natfrp.com/bestpractice/domain-bind.html)配置。

TCP 隧道通常使用高位端口。部分公司网络、运营商或微信内置浏览器可能限制该端口。请先用 `npm start -- --probe` 验证，不能只凭官网可打开就认为隧道可用。

## 其他免费服务

| 方案 | 官方免费能力 / 主要限制 | 本项目状态 |
| --- | --- | --- |
| [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) | 临时 HTTPS 地址，无需账号或自有域名；地址会变，无可用性保证，最多 200 个在途请求，不支持 SSE；[Tunnel 支持 WebSocket](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/) | 候选，未接入公开启动器；需要验证当前页面使用的传输方式 |
| [localhost.run](https://localhost.run/docs/forever-free/) | 免费，无需专用客户端，使用系统 SSH；域名定期变化，有限速；[提供 HTTPS](https://localhost.run/docs/http-tunnels/) | 后端保留历史实验实现，当前启动器未接入；不能当作已验收的手机连接 |
| [ngrok](https://ngrok.com/docs/pricing-limits/free-plan-limits) | 免费 HTTPS、一个分配的开发域名；每月 1 GB 出站、2 万次请求，浏览器访问有提示页 | 候选，未接入；频繁轮询可能较快消耗请求额度 |
| [OpenFrp](https://docs.openfrp.net/) | 基础端口映射免费，提供国内外节点；HTTPS、域名、认证条件需按所选节点核对 | 候选，仅做过资料与部分域名可达性检查，未创建或验证实际隧道 |
| [cpolar](https://www.cpolar.com/) | 原有实现使用的提供商；免费条件以其官网为准 | 仓库保留历史模块，但当前公开启动器使用樱花 |

开发环境曾出现 cpolar 公网域名被当前网络 DNS 返回 NXDOMAIN；一些国外候选的相关域名也解析失败。樱花则在同一环境实际完成了隧道验证。**这些只是特定时间、特定网络的结果，不代表其他用户也能或不能访问。**

## 替换中转要验证什么

需要的不只是一个能托管网页的地址。电脑必须能主动连接中转，手机也必须能访问公网入口；中转必须正确传递 HTTPS 请求、WebSocket、Host 和 Origin，并保留配对机制。

接入新提供商时，应沿用当前检查顺序：证书验证 → `/healthz` 实例身份 → `/probe/ws` 消息往返 → 页面资源 → 配对 → 会话读写。不得为了通过检查而关闭证书验证或全局放开来源限制。

免费隧道不会替代 Codex 模型账号或模型费用。流量上限、节点可用性与电脑睡眠仍影响使用。
