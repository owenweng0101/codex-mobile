# 原 H5 手机入口与本机 Codex 身份适配

仅本 stage；未改原 App、旧 outputs、root 服务文件、公网、账号 store，未启动 host 或业务会话。root 负责浏览器和真实服务验收。

## 可用文件与原代码保留范围

- `platform-services.mjs` 导出 `createPlatformServices({api,stateDir})`（别名 `createCodexPlatformServices`），返回 channel 到 service 的对象。`api.get()` 是 root 的真实 CodexReadClient。提供 setting、oauth、credential、model-selection、provider-settings、system；project/task 由另一适配模块负责。
- `build-compat.mjs` 从保留的原始 bundle 生成 `assets/index-BsmXQHMM.js`，只替换一次 `Atr();export{`。停止原自动 boot，增加原组件挂载包装和三个出口：`__codexOriginalConnect`（原 t7n）、`__codexOriginalPlatform`（原 ytr）、`__codexOriginalMount`（使用原 C2 / _o / U5n）。
- `browser-adapter.mjs` 导出 `mountCodexOriginalH5`，为原 U5n 提供真实工作区 switcher。U5n、W5n、HNn、composer、首页和所有 UI 函数均未改。
- `bundle-patch-manifest.json` 记录原 hash、产物 hash、精确 replacement 和 replacement count。测试验证将 replacement 反向替换后与完整原 bundle 字节一致。

必须在原 canonical URL `/assets/index-BsmXQHMM.js` 返回兼容产物；HTML 原入口改成 root 的 `/codex-entry.mjs`，配对成功后再 import canonical URL。否则 lazy chunk 的反向 index import 会造成两个模块实例或原 Atr 双启动。其余原 CSS / lazy module URL 保留。

## 为什么进入原手机壳而不出现原云登录门禁

原 U5n 自带完整 Provider 和 W5n；W5n 将 `!!webRemoteControlWorkspaceSwitcher` 作为 `isWebRemoteControlRoot`，传递原 HNn 手机壳。原 `x3n` 对此返回 false，禁用桌面 provider 登录门禁；这与原 cloud `fe/me` 的渲染配置一致。

本适配器使用 root 自己的 Codex 配对 cookie，不提供 ZCode JWT，不伪造 zai/bigmodel 登录身份。oauth.getProviders 返回空云登录列表、getActiveProvider/getUserInfo 返回 null，credential.load 不读取或返回用户凭证。原始云设备 token/relay transport 未启动。主动点击 ZCode 云账户写操作会明确不支持，而不是声称已登录。

## Root 前端调用

配对由 root 先完成。之后：

```js
const compat = await import('/assets/index-BsmXQHMM.js');
let controller;
const services = await compat.__codexOriginalConnect(
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
  {onClose() { controller?.setTransportState('connecting'); }},
);
const info = await (await fetch('/api/server-info', {credentials:'same-origin'})).json();
controller = await mountCodexOriginalH5({
  compat, services, info,
  async resolveNavigation(request) {
    const response = await fetch('/api/navigation', {
      method:'POST', credentials:'same-origin',
      headers:{'content-type':'application/json'}, body:JSON.stringify(request),
    });
    const result = await response.json();
    if(!response.ok) throw Error(result.error || '导航失败');
    return result;
  },
});
```

实际 entry 应先声明 `let controller`，避免 onClose 早于 const 初始化时进入 TDZ。controller 的连接状态接口只更新原壳提示，不自动伪造重连完成。调用方重新建立真实 services 后才可恢复 paired。

## `/api/server-info`

必须在 cookie 鉴权之后返回：

```js
{
  authenticated:true,
  deviceId:'local', deviceName:'Codex · 当前 Mac', devicePlatform:'darwin',
  workspaces:[{path:'/已由真实项目或会话登记的目录',label:'项目名'}],
  initialWorkspaceAbsPath:'/上述某个目录',
  // 可选：initialWorkspaceIdentity、initialTaskId
}
```

workspaces 可用 `workspacePath` 替代 path；如有 workspaceIdentity，导航验证必须匹配它。不能传整台 Mac 根目录代表所有目录已授权。初始工作区不存在或列表为空会明确拒绝挂载。

可选 `onChooseOtherDevice` 由 root 提供真实配对选择入口；未提供时不显示原设备选择按钮，避免无效按钮。

## `/api/navigation`（只读解析目标）

请求：

```js
{action:'workspace'|'draft'|'reconnect', workspaceKey, options?:{
  taskId, taskHostId, fileTreeTaskId, openFileManager, mobileNavigationIntent
}}
// 或
{action:'project-draft', project:{projectId,hostId?,projectName?}}
```

响应：

```js
{
  workspacePath:'/已登记的真实目录', workspaceIdentity?,
  initialTaskId?,
  initialTaskDraft?:{projectId,hostId?,projectName?},
  navigationIntent?:'chat', fileTreeOpen?:true, navigationKey?:'新的本地视图编号'
}
```

服务端验证实际 project/thread、目录归属及允许列表；只读取元数据，不 attach/resume/create/send。project-draft 仅打开原 composer；发送由后续真实任务契约处理。浏览器也会再次确认响应目录在 server-info 的列表中，未知 workspaceKey 不发请求，晚到响应不会覆盖新导航。

原 `updateMobileViewState` 与 `updateMobileTaskView` 在本 stage 仅保留本地浏览状态，不向桌面写“手机已读”或宣称已同步。`markTaskRead` 尚未接线。

## Provider / model view 精确形状

模型来自 `/api/models`，在线状态来自 `/api/status`。没有模型目录时抛错，不伪造模型；没有原生 effort 的模型暂不暴露选择。`model-selection.getView()`：

```js
{revision:1,providers:[{
  providerId:'codex-app', providerName:'Codex 本机',
  config:{group:'standard-personal',access:null,api:{type:'openai-responses'},visibility:'visible'},
  models:[{modelId:'实际 model 字符串',config:{
    enabled:true,
    properties:{inputFormat:{supportsText:true,supportsImage:false},outputFormat:{supportsText:true}},
    optionSpecs:{reasoningLevel:{values:['实际原生 effort']}}
  }}]
}]}
```

这里 api.type 是原 UI 模型目录兼容字段；没有 API key 或外部 endpoint，实际执行始终要走 root 的 Codex 映射。不是把它注册成一个 ZCode 云模型提供商。

`provider-settings.getView()` 必须有 `providerTemplates:[]`、`providerOrder:[]`、`providers:[]`；每个 provider 有 enabled、executable、effectiveConfig、issues、models；每个 model 有 enabled、executable、selectable、effectiveConfig、effectiveBuiltinConfig、issues。不能给 undefined 或只有 `{}`，否则原 `.providers.find` / `.models.find` 会出错。

原 toolbar 的 `bt(agentType)`（validation 模块导出 lr）只认字符串 `glm`。这是旧 UI 的 engine type；不能与模型目录的 providerId `codex-app` 混为一谈。真实任务适配应在服务端将原 UI 请求翻译为 Codex 的 model/effort，不把 `glm` 当作调用 ZCode 模型的授权。

setting 默认 `providerFamilyDomainMigrated:true`，使原启动逻辑不自动迁移或写第三方 provider domain。locale/theme 等只改本适配器内存偏好，尚未跨服务重启持久化。

## 验证与限制

`node --test adapter-stage.test.mjs` 验证：单处入口修改且全原 UI 字节保留；原 U5n props/switcher；目录边界；晚响应；真实模型形状投影和无 ZCode 云身份。兼容 bundle 与两个模块均通过 node --check。

本 stage 未做浏览器、原页面实体交互、真实项目会话读取或发消息验收。原组件还可能请求未提供的系统、模型编辑或账号方法；应在 root 的真实浏览器中显示明确不支持并逐项补接，不能为了过页面而返回虚假成功。

## 首次初始化辅助服务补充

`support-services.mjs` 单独导出 `createSupportServices({api,baseServices})`。baseServices 传已有 platform/read 服务集合，尤其需要真实 `project.readTree()` 验证 workspace roots/tasks。不要让这里的 closed fallback 覆盖 read agent 新增的真实 window-controller 或 task-groups 方法；按通道保留真实方法，再补缺失方法。

- broadcast 是本适配器的真实内存事件，不宣称跨原 App 进程同步。
- ZCode 动态工作流、云推荐和营销均明确 disabled；不访问对应账号或云接口。
- onboarding getOnboardingEligibility 返回 shouldOnboard:false 且带 disabled/reason，getLatestEntry/getRecords 为 null。claimAnonymousRecord、appendRecord 等迁移/记录写操作立即拒绝。原 UI 会捕获 claim 错误并继续资格检查，因此不会要求本机 Codex 用户迁移 ZCode 账号。
- settings-sync 的原前端只看 handled 字段：此处返回 handled:true、disabled:true、decision:skip-zcode-settings-import。这是适配器关闭 ZCode 导入向导的政策，不是声称用户已经导入或迁移成功；markFirstRunPromptHandled 等写操作未开放。
- zcode-agent helloConversationV4 检查真实 `/api/status` 的 online，再返回原协议3/replayable 握手；auth为空，nativeDialogs/localTerminal/workspaceHookReview/independentPlanState/workflowRunDeltas/historyFirst 全部 false。initializeConversationV4 只记录本适配器内存中的 clientHello 绑定，不创建 native 会话。
- agent/session initialize 仅对真实项目根或真实会话目录返回只读可用能力，不启动 host 或 engine。readWorkspacePresentation 是标明 adapter-default 的只读 UI 展示默认，不代表修改/读取了原生会话权限。
- git、未知 window-controller 和未适配 V4操作立即抛 CODEX_ADAPTER_UNSUPPORTED，不返回干净仓库、后台计数或虚假的授权状态。真实 controller task-list 和订阅由 read agent 接线。
- 补齐原 OAuth 缓存恢复的 signed-out 读取，不读 ZCode 用户目录。

`support-services.test.mjs` 覆盖禁用政策、无迁移写、真实在线握手、目录范围、内存广播与未知操作立即拒绝。该辅助模块不启动服务、不调用模型。
