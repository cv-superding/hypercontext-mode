# HyperContext Mode 验证记录

> 验证对象：`cv-superding/hypercontext-mode` @ `e58a2d9`（2026-10-20）
> 追加：同日晚些时候验证了 `autofold` 模式的配置生成与端到端折叠（见第 6 节）。
> 环境：Windows + Node 24；所有实验在临时 `HYPERCONTEXT_HOME` / `XDG_STATE_HOME` 中运行，不碰正在使用的实例。

这份记录回答两个问题：

1. **沙箱层**（context-mode）到底有没有省字节？
2. **压缩层**（billion-context）到底会不会折叠历史、折叠后是否真的省？省多少、什么时候不省？

结论先说：

- **沙箱层是真的**，工具输出/日志的节省可以稳定复现，适合现在就用。
- **压缩层也是真的**，但上一次 README 的“纯透传、零收益”是**基准测错了泳道**，不是压缩算法无效。
- 压缩层**不是免费**：每个主请求会注入约 **20.3 KB**（11.4 KB system prompt + 6 个工具等）。只有折叠发生得够早、折叠后还会继续跑足够多轮，才划算。30 轮 A/B 中净省 **278.3 KB（约为直连的 10.1%）**；如果折叠后很快就结束，反而会亏。

---

## 1. 沙箱层：已复现，收益大且稳定

复现脚本与数据在 `tools/bench-*.mjs`、`docs/bench/*.json`。关键数字（本机实测）：

| 场景 | 结果 |
|---|---:|
| 大文件/工具输出：原始 vs 经沙箱 | **274,268 B → 3,878 B** |
| 130 KB 日志写入沙箱后回读 | **738 B** |
| 精确标识符检索（`RefreshClientBadges` 等） | **3 / 4** 命中 |
| 自然语言提问检索 | **0 / 4**（这是 FTS5 关键词检索的边界，不是 bug） |
| 统一 MCP 工具的固定成本 | **28,211 B / 会话** |
| hook + MCP 固定成本 | **32,648 B / 会话** |

沙箱层的真实 A/B（`installer/HyperContextSetup.cs`，1758 行 / 68,567 B，6 个问题）：

| | 直连 | 经沙箱 |
|---|---:|---:|
| 输入字节 | 68.6 KB | **29.2 KB（−57%）** |
| 正确率 | 5 / 6 | 5 / 6 |
| 工具调用次数 | 4 | 11 |

**判断**：省字节是真的，代价是工具调用次数变多、自然语言检索弱。固定成本约 32.6 KB/会话；按上面的 A/B，大约 **0.84 个任务**就能回本。对“一次读大文件/大日志”的场景，沙箱层现在就有用。

---

## 2. 压缩层：上次的负面结果是基准 bug

`tools/bench-compression.mjs` 的每一轮都发：

```json
{ "max_tokens": 64, ... }
```

代理把 `max_tokens <= 200` 判为 **side request**，走透传并只剥标签，**完全不碰 kernel 状态**。所以它看到的“无工具、system 2 B、纯透传、`overview.requests=0`”是这条泳道的设计行为，不是压缩层的行为。

把同一脚本只改成 `max_tokens: 1024` 后，代理立刻进入主请求路径：注入 **6 个工具** + **11.4 KB system prompt**，`overview.requests` 从 0 变成 31。

真正的问题是：mock 模型从来不会调用 `compress`。压缩层要模型配合——模型得按 system prompt 的提示调用 `compress({content:[{startId,endId,summary}]})`。所以只改 `max_tokens` 仍然看不到折叠；需要**会配合的 mock**。

---

## 3. 协作式 mock 的 A/B（核心结果）

脚本：`tools/bench-compression-coop.mjs`
原始数据：`docs/bench/compression-coop.json`

做法：

- 同一段 30 轮、逐轮变长的对话，跑两遍：
  - **baseline**：mock 永远返回 `ok`，不折叠；
  - **compress**：mock 在第 20 轮返回一个真实的 `compress` tool_use，范围 `m00001–m00034`，summary 480 字符。
- 每轮请求 `max_tokens: 1024`，客户端每轮重发完整历史（真实聊天客户端的行为）。
- mock 上游记录代理实际转发的每一个字节。
- 两遍各自使用独立的 `XDG_STATE_HOME` / `XDG_CONFIG_HOME` / 临时端口，避免上一次的 session 状态污染（这一点很关键：不隔离时第二次运行会续上第一次的 session，`overview` 会显示 2 个 session / 99 个请求，数字全乱）。

### 3.1 折叠确实发生

第 20 轮 mock 调用 `compress` 后，代理返回：

```
[Compressed m00001–m00034 → 1 block(s), ~23951 tokens saved.]
 · b1 full summary 480ch ...
```

- `blocks = 1`
- `tokensSaved = 23,951`
- `summaryCost = 120` tokens
- 第 21 轮线上消息数 **41 → 9**（summary + 未折叠的尾部）
- 第 30 轮线上消息数 **61 → 27**

这不是“透传”，是实打实的历史改写。

### 3.2 字节账

| 指标 | 数值 |
|---|---:|
| 直连：客户端历史总和（31 次请求） | **2,757.8 KB** |
| 代理 baseline（不折叠） | **3,388.3 KB** |
| 代理 + 折叠 | **2,479.6 KB** |
| 代理固定开销 | **630.4 KB**（**20.3 KB/请求**） |
| 折叠带来的转发节省 | **908.7 KB** |
| 相对直连的净结果 | **+278.3 KB（省 10.1%）** |
| 折叠后 10 轮的节省 | **908.7 KB**（约 **90.9 KB/轮**） |

折叠前（第 20 轮）转发 **137.8 KB**；折叠后（第 21 轮）**52.6 KB**。

### 3.3 回本点

固定开销 630.4 KB ÷ 折叠后每轮 90.9 KB ≈ **6.9 轮**。

也就是说：

- 折叠后还能跑 **≥ 7 轮**：开始净赚；
- 折叠后马上结束：**亏**（开销已经付了，节省还没发生）；
- 30 轮里折叠在第 20 轮，后面还有 10 轮 → 净省 278.3 KB。

默认 nudge 是“增长 50K token 才提示折叠”，本次为了在 30 轮内看到效果，强制在第 20 轮（约 29K token 历史）折叠。真实默认路径会折得更晚、单次折得更大；是否划算取决于折叠后还剩多少轮，不能只看“单次省了多少”。

---

## 4. 仪表盘数字要打折看

代理 `/__bili/overview` 的本次 session 报：

```
tokensSaved: 23951
netSaved: 238190
summaryCost: 120
blocks: 1
```

`netSaved ≈ 23,951 × 10`，是折叠后 10 轮累计的“折叠 token 数 − summary 成本”，**没有减去每个请求注入的 20.3 KB**。按 4 B/token 粗算，630.4 KB 开销约 **15.7 万 token**；把它算进去，30 轮的真实净节省远小于 238K token（字节账是 +278.3 KB，约 7 万 token）。

所以：

- `tokensSaved` / `netSaved` 可以用来判断“折叠有没有发生、折了多少”，**不能直接当“净省”**；
- 真正的净结果要用“转发字节总和（含注入）− 直连字节总和”来算。

---

## 5. 还没验证 / 不要过度外推

1. **模型会不会配合**：本次 mock 是“完美配合”的上界。真实模型可能不调用 `compress`、折错范围、或写很长的 summary。480 字符 / 120 token 的 summary 偏短；真实 summary 更长，净节省会小一些。
2. **真实客户端端到端**：没有在 Claude Code / Qwen Code / Gemini CLI 的长会话里数过真实 fold 次数。README 里的客户端 A/B 只覆盖沙箱层。
3. **可逆性**：`decompress` 工具存在，引擎测试也覆盖了它，但本次 A/B 没有调用 `decompress` 做端到端还原验证。
4. **prompt cache**：20.3 KB/请求的注入如果被缓存，实际费用会低于字节占比；本次没有模拟 cache 计价。
5. **短会话**：没有折叠就不会省，固定开销是纯亏。30 轮以内、且没有触发折叠的会话，应该关掉压缩层，只用沙箱层。

---

## 6. 修复方向：autoFold 把“模型配合”变成“代理自折叠”

billion-context 的 `compress.externalSummary.autoFold` 已经在 `engines/billion-context/tests/external-summary-autofold.test.ts` 里覆盖：代理自己选范围、调用独立摘要模型，主模型不参与。关键问题是它和注入开销能否同时解决。

本次用一个临时探针（`startServer` + mock 主上游 + mock 摘要上游，36 对消息 / 50K 窗口 / `autoFoldTargetTokens=8192`）对比“注入开 / 注入关”，两组都开 autoFold：

| 指标 | autoFold + 注入开 | autoFold + 注入关 |
|---|---:|---:|
| 注入 system | 12,193 B | **582 B** |
| 注入 tools | 6,684 B | **2 B** |
| 主上游收到的消息 | 73 → 9 | 73 → 9~11 |
| 摘要调用 | 16 次 / 316,281 B 输入 | 15~16 次 / ~300 KB 输入 |

再用打包后的 `engines/billion-context/dist/index.js` 和 `ensureBillionConfig` 生成的配置做了一次端到端：HTTP 200，主上游收到 **11 条**消息（原始 73 条），注入 **system 582 B / tools 2 B**，摘要 **15 次 / 301,065 B 输入**。这次端到端同时验证了配置生成、代理加载和 autoFold 折叠链路。

结论：

- autoFold 不依赖主模型调用 `compress`，折叠照常发生；
- 关掉 `injectTool` / `injectNudge` 后，每请求固定注入从 **18,877 B 降到 584 B**（约 −97%）；
- 代价转移到摘要模型：这次合成数据是 15~16 次调用、约 300 KB 输入。真实成本取决于摘要模型价格、`autoFoldTargetTokens` 和 `concurrency`；本次没有用真实摘要模型和真实账单验证。

因此产品化方向不是“默认开协作式压缩”，而是：

- 有可用摘要模型 → `compression.mode=autofold`，代理自折叠、关闭注入；
- 没有摘要模型 → 短会话只用沙箱；长会话才开协作式，或等 cold-start 注入门槛；
- 两种模式都不应该在每个短会话上默认交 20 KB/请求的固定税。

---

## 7. 建议

- **现在就用沙箱层**：大文件、日志、网页、issue 列表的读取，收益稳定。
- **压缩层按场景开**：长会话、工具输出多、模型愿意遵守 system prompt（Claude 系通常更愿意）；短会话或小模型先别开。有便宜摘要模型时优先 `compression.mode=autofold`，它不依赖主模型配合，且关闭注入后固定开销只有 ~0.6 KB/请求。
- **验证时至少满足**：
  - `max_tokens >= 201`（否则走 side-request 泳道，永远看不到折叠）；
  - mock/模型真的会调用 `compress`；
  - 用独立的 `XDG_STATE_HOME`，别让上一次的 session 续上；
  - 同时报“直连 / 不折叠 / 折叠”三组字节，并把注入开销算进去。
- **下一步最值得补的实测**：在 Claude Code 或 Qwen Code 里跑一个 ≥ 30 轮的真实会话，记录 `blocks`、`foldCount`、`tokensSaved` 和真实账单，验证“模型是否会在 nudge 后主动折叠”。这比再加一个 mock 更有说服力。

---

## 复现命令

```bash
npm install
npm run setup:engines
npm run build:engines

# 旧的负面基准（只用于复现 side-request 泳道，不要用它判断压缩层）
node tools/bench-compression.mjs --json docs/bench/compression.json

# 协作式 A/B（本文核心结果）
node tools/bench-compression-coop.mjs --json docs/bench/compression-coop.json

# autoFold + 关闭注入的端到端（需要已构建 billion-context）
node tools/bench-autofold.mjs --json docs/bench/autofold.json
```

可调环境变量：`COOP_TURNS`（默认 30）、`COOP_FOLD_TURN`（默认 20）、`COOP_FILLER_REPEAT`（默认 120）。脚本会自动选择空闲端口，并用 `taskkill /T /F` 清理代理进程树，避免 Windows 上残留进程污染下一次运行。

---

## 8. 六个缺口的补齐与实测（2026-10-20 续）

第 1–7 节留下的问题，这一节逐条补齐，并用**真实构建、真实测试、真实字节账**验证。所有数字来自本机实测脚本，原始数据在 `docs/bench/*.json`。

### 8.1 冷启动门槛：不再每个请求都交注入税

机制：新增 `compression.coldStartTokens`（默认 `32_000`），由控制面通过托管环境变量 `ACP_INJECT_AFTER_TOKENS` 交给引擎。原始请求 token 估算低于阈值时，**四个注入面全部关闭**——compress 工具、nudge、tags-only system prompt、absorb/rules 提示。阈值一旦被跨过，**该会话永久打开（latch）**，这样原生 compact 之后注入面不会中途消失。

实现：`engines/billion-context/src/server/inject-gate.ts`（新增）+ 四个 wire 的 prepare 路径 + `handle.ts`；**没有改 kernel**，也没有给引擎新增配置文件字段（只多了一个环境变量）。

引擎测试 `engines/billion-context/tests/cold-start-gate.test.ts`（6 项全过）：

| 断言 | 结果 |
|---|---|
| 低于阈值：system 与客户端逐字节相同、工具表里没有 `compress` | ✅ |
| 跨过阈值：第一个越界请求就带上压缩 prompt + 工具 | ✅ |
| 打开后再来小请求：仍然注入（latch 生效） | ✅ |
| 阈值 `0`：第一个请求就注入 | ✅ |
| 注入时 `injectedOverheadTokens > 0`（实测，不是猜） | ✅ |
| 门槛关闭时 `injectedOverheadTokens == 0` | ✅ |

真实客户端验证（`tools/bench-claude-e2e.mjs`，**真的 Claude Code 2.1.177 CLI**，30 轮，mock 上游）：

| 阈值 | 门槛状态 | 注入开销（30 轮累计） | 折叠节省 | 净 |
|---|---|---:|---:|---:|
| `8_000` | 第 1 个请求就打开（30,472 ≥ 8,000） | **135,510 token** | 0 | **−135,510** |
| `32_000`（默认） | 30 轮都没跨过 → **始终关闭** | **0** | 0 | **0** |

这直接量化了之前只能估算的那笔“固定税”：**阈值开太大，每个请求要多付约 4.5K token**；默认 32K 门槛在短会话里等于“压缩层不介入”，客户端看到的对话与直连逐字节一致。

### 8.2 统一会话身份：两层用同一个 id 接上

Claude Code 的原生 session id 在 hooks、代理、MCP 三处本来就是同一个。控制面现在从沙箱 `session_meta` 里按项目取“最近一次活动会话”，再和压缩层索引 `sessions.session_id` 对齐：两边都有这个 id 时，联邦检索自动收窄到这一场会话（`hctx search`、MCP `hc_search` 同源）；`--all-sessions` / `all_sessions=true` 可退出收窄。

控制面测试 `tests/profile-meter.test.ts` 覆盖：对齐成功、收窄后只命中本会话、`all_sessions` 退出收窄、显式 `--session` 覆盖。

### 8.3 lean MCP 门面：工具表从 28.5 KB 降到 11.3 KB

保留 `hc_*`、`ctx_execute`、`ctx_search`；其余 `ctx_*` 收进一个调度器 `ctx_more`（`tool` + `arguments`），需要时才展开。实测（`tools/bench-mcp-cost.mjs`，真实 context-mode 子进程）：

| | 工具数 | schema+描述合计 |
|---|---:|---:|
| full | 14 | **28,502 B** |
| lean | 6 | **11,330 B** |
| 差 | −8 | **−17,172 B（−60.2%）** |

`ctx_more` 调度器不是纸面功能：脚本用 MCP 客户端真实调用 `ctx_more → ctx_stats`，拿到了子进程返回的真实内容（`dispatcherWorks: true`）。

### 8.4 真实净计量（net meter）

`hctx meter` / `hctx status` / MCP `hc_status` 现在给出的是**净额**，不是“折叠省了多少”：

```
net = gross saved − re-pay − summary output − summary input − injected overhead
break-even = ceil(overhead ÷ (gross saved ÷ post-fold requests))
```

新增的度量全部是实测值，不是配置推算：

- `injectedOverheadTokens`：每个请求“出站 system+tools”减“入站 system+tools”，逐请求累加；
- `summaryInput/Output/Calls/Latency`：外部摘要调用回调里统计，token 用引擎自带 tokenizer 估算，**延迟是真实墙钟**；
- `postFoldRequests`：折叠已经在位时到达的请求数（按请求计数，不依赖 cache ledger 有没有 usage 样本）。

计价的 token 数是“估算”，**没有测过任何真实账单**——本机没有可用的 provider 凭据，`pricing.*` 只是把 token 换算成钱的公式。

### 8.5 真实摘要器：本地 Ollama 实测（含负结果）

`tools/bench-summary-real.mjs` 用**真实引擎 + 真实摘要模型**（本地 Ollama 的 OpenAI 兼容端点）跑完整 autoFold 链路：

| 指标 | 实测 |
|---|---|
| 摘要调用 | 20–25 次 |
| 摘要输入（估算 token） | 87,889 – 114,264 |
| 摘要输出（估算 token） | 7,326 – 13,096 |
| 摘要总延迟（真实墙钟） | 47,459 – 236,100 ms |
| 单次平均延迟 | 2,373 – 9,081 ms |
| 注入开销 | 508 token |
| 折叠后请求 | 3 |
| 事实召回（8 条关键事实） | **75% – 100%** |
| 净结果 | **−61,496 ~ −100,967 token（负）** |

两个诚实的负结果：

1. **本地小模型在 token 账上是亏的**：为了省 26,901 token 的历史，0.5B 模型要重读 10 万级 token 的输入。便宜不等于划算，得按“每百万 token 的价格 + 重读量”一起算。本地模型没有单价，所以这里只报 token，不报钱。
2. **机器上原有的两个 deepseek GGUF 不可用**：Ollama 0.33.2 对 `deepseek-1.5b-q3km:latest` 和 `deepseek-r1:1.5b` 的 chat 请求都返回 `400 "does not support chat"`（这两个 GGUF 没有 chat 模板）。为了拿到真实数据，临时拉了 `qwen2.5:0.5b`（约 400 MB）。

延迟是真实的，质量是真实的（8 条事实召回 75%–100%），**账单不是**——本地模型不计费，任何 provider 账单都没有测过。

### 8.6 真实客户端 e2e：Claude Code 30 轮通过

`tools/bench-claude-e2e.mjs` 驱动**真的 Claude Code CLI**（2.1.177）：30 次 `--print` 调用（`--session-id` 起头，之后 `--resume` 续同一场会话），走压缩代理打到本地 mock 上游；同一套提示再直连 mock 跑一遍做基线。

| 指标 | 经代理 | 直连基线 |
|---|---:|---:|
| CLI 调用次数 / 失败 | **30 / 0** | 30 / 0 |
| 客户端历史最大消息数 | 59 | 59 |
| 单请求字节（首） | 147,529 B（阈值 8K）/ 131,814 B（阈值 32K） | 131,670 B |

两个必须写下来的观察：

- **代理路径下客户端每轮多发一次 sidecar 请求**（独立 session id、无工具面）。它在 `--passthrough`（完全透传）下同样出现，所以**不是压缩流水线造成的**；响应在透传模式下与 mock 逐字节相同，因此这是客户端在代理延迟下把“标题生成”这类异步 sidecar 发出来了（直连时进程先退出，请求没来得及发）。这一点没有继续深挖，如实记录。
- **这 30 轮里压缩层没有折叠**：mock 只回一个词，历史长到 59 条消息也没到可折叠区间，`grossSaved = 0`。所以“压缩层在真实客户端上的净收益”本轮仍然**没有测到**——测到的是“真实客户端在压缩层下正常工作、门槛按预期开合、开的时候确实要付注入税”。

### 8.7 Profile 预设

`hctx profile lean|balanced|maximum`（或 `hctx config set profile ...`）是**显式命令**，加载配置时不会偷偷改写字段：

| profile | 沙箱 | 压缩 | 记忆注入 | MCP 门面 |
|---|---|---|---|---|
| `lean` | 开 | **关** | full | lean |
| `balanced` | 开 | 开（有摘要模型则 `autofold`，否则 `cooperative`） | auto | auto（=lean） |
| `maximum` | 开 | 开（同上） | minimal | full |

`mcp.toolset` 显式写 `full`/`lean` 时永远优先；`auto` 只在 `maximum` 下等于 full。

### 8.8 这一轮仍然没有验证的

1. **Codex CLI / Qwen Code 的真实 e2e**：本机没有装这两个客户端（`codex`、`qwen` 命令不存在），因此**没有**它们的 ≥30 轮实测数据。
2. **任何 provider 的真实账单与真实单价**：没有凭据，计量只到 token。
3. **真实模型配合 `compress` 的折叠率**：Claude Code 这一轮是 mock 上游，模型不调用 `compress`；只有 autoFold（代理自折叠）这条不依赖模型配合的链路被真实跑通。
4. **客户端 sidecar 双请求的根因**：如上，如实记录未深挖。
5. **kernel 未改动**：所有新逻辑都在宿主侧（引擎的 host 代码 + 控制面），kernel 的行为常量一个没动。

---

## 9. 第三个真实客户端：OpenCode，以及「组合后为什么变弱」的实测答案

第 8 节留下的问题：宿主自带压缩时，HyperContext 的压缩层还剩什么价值。`tools/bench-opencode-e2e.mjs` 用**真的 OpenCode CLI**（1.2.24）回答了它。

> 补充说明：本机的 OpenCode 凭据全部失效（`opencode` 免费档返回 403「只能在 OpenCode 内使用」、`deepseek` key 无效、`minimax`/`deepinfra` 未授权），且 CLI 1.2.24 的目录里还没有 `deepseek-v4.1-flash-free`。因此这一轮用**本地 mock 上游**（真实客户端、真实代理、真实宿主压缩路径；不计费、不测真实模型质量）。要跑真实免费 200k 档，需要先 `opencode upgrade` + `opencode auth login`。

### 9.1 宿主的原生压缩确实存在，而且看得见

12 轮，每轮 4 KB 提示，模型窗口钉在 24k。OpenCode 自己在超窗前压缩，**在网线上是可见的**：请求体积从 82 KB 掉到 30 KB（−63%），消息数从 14 变 17（历史被换成摘要）。

### 9.2 三组对照（同 12 轮、同一 mock 上游）

| 运行方式 | 上游请求数 | **宿主压缩次数** | 总请求字节 | 引擎折叠 |
|---|---:|---:|---:|---|
| 直连（不用 HyperContext） | 17 | 2 | 1,009,644 B | — |
| 经代理，**协作式**（注入开） | 26 | **6** | **1,626,740 B（+61%）** | **0 次** |
| 经代理，**autoFold**（注入关） | 16 | **2** | **949,368 B（−6%）** | **1 块，1 次摘要调用** |

**这就是「组合后变弱」的机制，而且是可测的：**

1. **注入的 prompt + 工具算进宿主的上下文预算**。协作式模式每请求注入约 4.5K token（实测 25 个请求共 **113,957 token**），宿主以为自己的上下文涨得更快，于是**压缩次数从 2 次涨到 6 次**——宿主的有损压缩被我们的注入**逼得更频繁**。
2. **协作式一次都没折**（0 blocks）：模型不调用 `compress`，我们只付钱不干活。
3. **autoFold 反过来**：注入关掉后每请求只剩 584 B（25 个请求共 **2,034 token**，差 56 倍），代理自己折了 1 块（1 次摘要调用、3,951 输入 token），宿主压缩次数回到 2 次，**总字节比直连还少 6%**。

结论：**对自带压缩的宿主，压缩层要「赢下这一轮」才有价值**——必须在宿主压缩之前先折，而且不能靠注入去催模型。autoFold（代理自折叠 + 注入关）就是这套配置；协作式（注入开）恰好是最差的一档。

### 9.3 顺手修掉一个真 bug：宿主压掉的内容搜不到

宿主压缩后，引擎会裁掉指向被丢弃原文的消息行（`applyCompactionArchive`），但**原文字节还留在 content CAS 里**。原来的联邦检索只走 `messages JOIN content` 和 `blocks JOIN content`，于是这些「孤儿」内容**永远搜不到**——也就是这层唯一该给的东西（被宿主压掉的历史还能找回来）丢了。

修法（`packages/core/src/federation.ts`）：检索时额外扫一遍 content CAS 里**没有任何 message/block 引用**的行，作为 `compression-archived-content` 命中返回。修完的实测：

- 协作式组：被宿主压掉的第 1 轮内容 **可检索** ✅
- autoFold 组：同样 **可检索** ✅

回归测试：`tests/profile-meter.test.ts` 的「content orphaned by a host-side compaction stays searchable」（活着的消息不会被重复报成孤儿）。

### 9.4 真实模型直连：免费 200k 档**没有**在 200k 前自动压缩

用真的 OpenCode v2.0.32 + 真的免费模型 `opencode/glm-5.3-flash-free`（官方目录：context **200,000**）直连跑，模型每轮读一个 400 KB 文件：

| 轮 | 本轮请求 input | 累计 input | 缓存读 | `time_compacting` |
|---|---:|---:|---:|---|
| 1 | 105,681 | 105,681 | 0 | null |
| 2 | 109,242 | 214,923 | 103,040 | null |
| 3 | 210,225 | 425,148 | 206,080 | null |
| 4 | 107,170 | 532,318 | 311,616 | null |

**结论（和直觉相反）**：请求峰值到了 **~210k token**（超过官方目录标的 200k），**OpenCode 一次都没跑自己的压缩**（`time_compacting` 始终为 null），只是自己修剪了一部分历史（每轮增量在 109k / 210k 之间交替）。免费档照单全收。

也就是说：**「宿主会在 200k 前自动压缩」不是这里发生的事**。宿主压缩要么是**被上游拒绝后被动触发**，要么取决于客户端自己的记账口径；本轮既没触发压缩也没触发报错。

对 HyperContext 的直接含义：

- 压缩层**不是**「防 200k 撞墙」的必需品（在这个档位上，上游比客户端的标称窗口更宽容）；
- 于是注入那 ~4.5K token/请求在**没有换来任何折叠**时就是纯成本（第 9.2 节：+61% 字节、宿主多压 3 次）；
- 所以新增了 `compression.inject` 开关（`auto` / `on` / `off`）：不配摘要模型、又不想交注入税时，`off` 之后压缩面完全不出现，窗口交给宿主。

### 9.5 这一节仍然没有验证的

1. **宿主压缩与我们的折叠同时发生**的交错场景（本轮两者是先后发生，不是同时）。
2. **请求被上游拒绝后宿主是否被动压缩**——需要把单轮请求推到远超窗口（更激进的跑法），本轮没跑到那个点。
3. **Codex CLI / Qwen Code**：本机未安装。
4. **免费档的模型流量经 HyperContext 代理**：v2 客户端不允许改 `opencode` provider 的 baseURL（官方把免费档锁在自家客户端），要插代理只能上证书 MITM——引擎给 claude/codex 用的那套还没接到 console 主机上。


