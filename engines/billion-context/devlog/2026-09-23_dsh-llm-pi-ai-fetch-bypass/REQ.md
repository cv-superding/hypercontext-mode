# REQ - dsh profile 安装"零模型请求"会话:让症状可自查、可一次定性(#1158)

- Task ID: `2026-09-23_dsh-llm-pi-ai-fetch-bypass`
- Home Repo: `billion-context`
- Created: 2026-09-23(同日二次修订:根因归因撤回,见 §1)
- Status: Done
- Priority: P1
- Owner: xiaofengkuai / ework-agent
- References: https://github.com/ranxianglei/billion-context/issues/1158

## 1. Background & Problem Statement

- **Context**: dsh 原生插件(profile 安装,免启动器)经 `globalThis.fetch` 补丁接管模型流量(`src/agent/native-intercept.ts`),归属判定依赖 `takeoverGate`(dsh AsyncLocalStorage initiator)。
- **Reported symptom(真实成立)**: dsh web GUI(profile `web`)下部分 `llm-pi-ai` 层传输服务的会话**从未有任何模型请求到达代理** —— bili.log 零 `processTurn`,`/__bili/stats` 无会话,`acp_status` 404 "no model request has arrived",压缩静默失效且不可自查;同宿主其他 provider 正常。
- **Root-cause status(重要修订)**: issue 原文与本文初稿断言的根因 —— "pi-ai 把注入的私有 fetch 传给 OpenAI SDK,绕过全局 fetch 拦截" —— **已被 owner 复核证据推翻**:逐层拆包(dsh-llm-pi-ai 全代次 / pi-ai 0.82.1–0.87.1 / openai SDK 6.26–6.40)显示 `options?.fetch` 自上游即为 `undefined`,SDK 构造时回落到 globalThis fetch(即已被补丁的实例);dsh 源码主聊天回路静态上被 `withInitiator` 包裹,llm 相关包零 `withoutInitiator`。issue 引用的 openai-completions.js :573-579 只证明注入通道**存在**,不证明被填充。真因待运行时证据定性,候选:(a) 报告环境存在未见过的版本组合形态;(b) 宿主运行时归属缺口(gate 拒绝静默直连);(c) A/B 对照不在同一进程/会话。owner 正在搭真实 dsh + bili + mock 上游全链路复现。
- **Expected behavior**: (issue 期望 #2 退一步方案)无论真因是哪个,请求未被接管时必须留下可操作痕迹:代理侧一次性告警 + 工具报错携带排查指引 + 宿主侧 gate 拒绝点可观测。
- **Impact**: 所有经 profile 安装(裸 dsh)且出现该症状的用户;功能静默失效。

## 2. Reproduction

- **Environment**: Windows 11,dsh web GUI(profile `web`),billion-context 0.1.138,`bili plugin install dsh`,provider 为 settings.yaml `llm-pi-ai.providers.*` 下任意一项。
- **Minimal reproduction steps**:
  1) `bili plugin install dsh`;
  2) dsh 中选 `llm-pi-ai` 管理的 provider 发几条消息;
  3) bili.log 无该会话 `processTurn`;`acp_status` 报 "no model request has arrived with this conversation id yet"。
  对照:同环境换用走普通全局 fetch 的第三方 provider(commandcode = 第三方插件 `@mars-sea/dsh-commandcode-provider`,与官方 llm-pi-ai 是两套实现),`processTurn` 立即出现。
- **本地无法完整复现**(需 Windows + dsh web GUI);本 PR 交付的是检测与仪器,使 owner 的运行时复现一次即可定性(见 §4.3)。

## 3. Constraints & Non-Goals

- **Constraints**:
  - 不得改变 `/__bili/plugin/tool` 404 错误中 `src/mcp.ts`(ORPHAN_ADOPT)与 `src/agent/opencode-v2.ts` 匹配的既有子串 `no model request has arrived` / `no model request has arrived with this conversation id yet`;
  - 不得触碰 `src/update.ts`、release 流程、acp-kernel pin(#7.4 auto-merge 禁区);
  - 内容分支不动 version;gate 布尔契约不变(加日志不改判定)。
- **Non-Goals**:
  - 通用拦截任意注入式 fetch(不可行:函数引用私有于宿主模块图,pnpm 隔离阻断跨模块补丁;undici 内部补丁过于侵入)。若运行时证据最终指向传输层 fetch 形态,真正修复属于 dsh 仓库(惰性解析 global fetch / 中间件 seam),跨仓保持人工;
  - 不给每个被拒请求打日志(#1117 的每请求静默仍保持):合法无归属车道(dsh 有意 `withoutInitiator` 的后台 driver、第三方进程内插件)最多每端点一行常驻噪声;
  - 不动 `handlePluginCompact` 的同型 404 文案(非本症状路径)。

## 4. Chosen Approach

假设中立的检测 + 一次性可操作告警 + gate 拒绝仪器 + 文档:

1. `handlePluginTool` 对"从未注册过"的 conversation(!entry)打**每会话一次性** `[plugin] NO MODEL REQUESTS seen for conversation …` 告警,列出候选成因(传输层 fetch 形态绕过拦截 / 宿主归属缺口致流量未被 gate 认领 / host resume 后 id 过期)+ 自查方法(发消息看 processTurn;走客户端 bili 启动器的 baseURL 重写在两种假设下都必然过代理)+ 404 error body 追加同样指引(保留既有子串);
2. `takeoverGate`(dsh-native)对**每端点每进程一次性**经 console.error 记录被拒 origin+pathname(query 剥离防泄 key)+ 当时归属状态(无 initiator / 有 initiator 缺 session id)—— 有拒绝行且聊天轮次本应归属 → 指向运行时归属缺口;无任何拒绝行而流量仍绕 → 指向传输层 fetch 形态;
3. README zh/en dsh 节条目改为"已报告、调查中"(撤回"已知局限=llm-pi-ai 注入 fetch"的断言),给出两个检测信号与启动器规避;
4. 回归测试:`tests/issue1158-no-model-request-warning.test.ts`(子串保持、一次性语义、entry 分支旧行为不变、文案不得点名单一已确认成因)+ `tests/dsh-native.test.ts` 新增 gate 拒绝日志测试(每端点一次、query 不入日志、不同端点各一行、有归属静默认领)。
5. **引导失败持久化到 bili.log(同日三次修订)**:owner Linux 全链路复现(headless + chromium 驱动 web GUI)未能复现症状,llm-pi-ai 全部流量均过代理;传输形态假设在 Linux 上出局,残余最大嫌疑 = Windows 特有的 spawn/attach 引导失败静默降级——唯一输出是一次性 console.error,GUI 进程 stderr 不可见。故 dsh-native 所有降级点(bootstrap catch / attach 目标不健康回落 / 三处 respawn onGiveUp)同时经 `persistClientEvent` 以 `[dsh-client]` 标记行追加进共享 bili.log(与代理 tee 日志同文件同行形,best-effort 永不向宿主抛错);console.error 双通道保留。
6. **Gate 三态 + 累计计数(L2 follow-up,#1187 落地后)**:报告者运行时证据钉死根因(dsh-http-proxy settings-refresh re-arm 用冻结的 pre-bili capture 覆写 `globalThis.fetch`,把 bili 踢出链;owner 已在 #1187 以 guarded accessor 自愈 L1)。按线程内达成一致的计划升级 gate 仪器:`attributionOf` 三态(ok / none / threw-with-message —— 旧 bare catch 把 `currentInitiator()` 异常吞成"无归属",throwing ALS 边界与合法 agentless 车道不可区分);每端点首次拒绝打一行(格式不变)+ 同态静默累计计数 + 仅状态迁移时重打 `(state none→threw)`;每条打印行同时经 persistClientEvent 追加进 bili.log(`[dsh-client]` 标记,GUI stderr 不可见是本次"零痕迹"的直接原因)。gate 布尔契约不变,#1117 每请求静默保持。
