# HyperContext Mode 验证记录

> 验证对象：`cv-superding/hypercontext-mode` @ `e58a2d9`（2026-10-20）
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

## 6. 建议

- **现在就用沙箱层**：大文件、日志、网页、issue 列表的读取，收益稳定。
- **压缩层按场景开**：长会话、工具输出多、模型愿意遵守 system prompt（Claude 系通常更愿意）；短会话或小模型先别开。
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
```

可调环境变量：`COOP_TURNS`（默认 30）、`COOP_FOLD_TURN`（默认 20）、`COOP_FILLER_REPEAT`（默认 120）。脚本会自动选择空闲端口，并用 `taskkill /T /F` 清理代理进程树，避免 Windows 上残留进程污染下一次运行。
