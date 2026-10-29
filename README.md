# 🎬 Video Remake 引擎（GitHub Pages 版）

复刻自 **Media.io Viral Studio** 的「贴视频链接 → 一键重制」能力。纯前端单页应用，部署在 GitHub Pages，**无需任何后端**。

- 输入：视频链接 + 你的 PowerTokens Key
- 输出：同构图、同节奏、同**时长与尺寸**，但**人物必换**的原创重制视频
- **模型由引擎固定**，用户不选模型、不选时长、不选分辨率——全部自动匹配原片
- Key 只存在你浏览器 `localStorage`，**不经过任何第三方服务器**

## 核心设计：模型固定 + 自动降级

用户不再需要懂模型。引擎内置一条**固定模型链**，按顺序尝试，前一个失败自动换下一个：

```
Wan 2.7 r2v  ──失败──►  MiniMax Hailuo 2.3  ──失败──►  Kling v3 运镜
  (首选，最强参考视频还原)       (中文语义/镜头语言强)          (兜底，原生运镜)
```

三个模型**各自有完全不同的 API 契约**，所以每个模型都有独立适配器（`adapters.mjs`），
上层只管传「原视频的时长、宽高、短边」，适配器负责把这些意图**夹到该模型自己的合法枚举值**上。

### ⚠️ PT 视频 API 不是一套统一契约

这是本项目踩过的最大的坑。**不同模型的端点、字段名、枚举值完全不同**：

| | Wan 2.7 r2v | MiniMax Hailuo 2.3 | Kling v3 运镜 |
|---|---|---|---|
| 端点 | `POST /v1/videos` | `POST /v1/videos` | `POST /kling/v1/videos/motion-control` |
| 模型字段 | `model` | `model` | **`model_name`**（必须 `kling-v3`） |
| 参考视频 | `media:[{type:"reference_video", url}]` | ❌ 不收视频 | **`video_url`** |
| 必填图片 | ❌ | ❌ **可选**（带图更像原片） | ✅ **`image_url` 必填**（人物主体图） |
| 时长 | `seconds` 字符串 2–30（有视频输入时 输入+输出 ≤30） | `seconds` **仅 `"6"` / `"10"`** | ❌ **无此字段**，继承参考视频 |
| 分辨率 | `size` ∈ **`720P`/`1080P`（实测无 480P）** | `size` ∈ **`768P`/`1080P`（没有 720P）** | ❌ 只有 `mode` ∈ `std`(720P)/`pro`(1080P) |
| 画幅 | `ratio` ∈ `16:9`/`9:16`/`1:1`/`4:3`/`3:4`（**不接受 adaptive**） | ❌ 由 image 决定 | ❌ 由参考视频决定 |
| 声音 | `generate_audio` bool | ❌ | `keep_original_sound` ∈ `"yes"`/`"no"` |
| 其他必填 | — | — | **`character_orientation`** ∈ `image`(参考视频≤10s)/`video`(≤30s) |
| 提示词上限 | — | 2000 字 | 2500 字 |
| 返回格式 | 标准 `{id, status}` | 标准 `{id, status}` | **Kling 原生 `{code, message, data:{task_id, task_status}}`** |
| 实测单价 | 5s 720P ≈ **$0.475** | 6s 768P ≈ **$0.266** | 按源视频时长计 |

所以「换模型」绝不是换个 `model` 字段名那么简单——**换错端点直接 404，换错枚举值直接 400**。
全部差异封装在 `adapters.mjs` 的 `fit()` 里，由 `adaptertest.mjs` 的 59 条断言守住。

> 早期文档曾说「所有视频模型统一走 `/v1/videos`」——**那是错的**。Kling 运镜必须走厂商原生路径。

### 🔬 实测契约（2026-10-28 逐条验证）

下面每一条都是**真发请求打出来的**，不是从文档抄的。方法是「用错误的值去试，让服务端的报错把真实结构吐出来」。

| 现象 | 服务端原话 | 结论 |
|---|---|---|
| Wan 传 `media` + `subject_reference` | `media cannot be used together with subject_reference` | **两者互斥**，只能二选一 |
| Wan 只传 `media` | 通过（进入扣费判断） | `media[0] = {type:"reference_video", url:"<string>"}` 正确 |
| Wan `media[].type` 传 `"video"` | `unsupported media.type: video` | 只认 `reference_video` |
| Wan `size` 传 `480P` | `only supports 720P or 1080P` | 没有 480P 档 |
| Wan `ratio` 传 `adaptive` | `only supports ratio 16:9, 9:16, 1:1, 4:3, or 3:4` | 不接受 adaptive |
| MiniMax `size` 传 `720P` | `model_price_error / pricing rule not found` | 只有 768P/1080P |
| MiniMax `seconds` 传 `5` | `model_price_error / pricing rule not found` | 只有 6/10 |
| MiniMax 不传 `image` | 通过 | **`image` 不是必填**（早期文档说必填，是错的） |
| MiniMax `10s` + `1080P` | 400 | 10 秒时强制 768P |
| Kling 不传 `model_name` | `Model name not specified` | `model_name` 必填 |
| Kling 传假 `video_url` | `failed to probe video_url duration: ffprobe probe error: Server returned 404` | **鉴权+字段全通过**，只在下载阶段失败 |

> `subject_reference` 是 Wan 的**另一种**输入方式（`[{type:"video", image:["<url>"]}]`），
> 用于「主体参考」；本项目的目标是把原片当**运动/构图参考**，所以统一走 `media`。

### 关于「参考图」的一个硬约束

PT 服务端只能访问**公网 URL**。本地文件路径它读不到，传过去必定 400。
所以：

- **网页版**：`canvas.toDataURL()` 得到 `data:image/jpeg;base64,...`，官方接受这种内联图。
- **CLI 版**：ffmpeg 抽帧到本地后，同样读成 base64 转 data URL 再发（`engine.mjs` 已实现）。
- 跨域导致 canvas 被污染时，网页版提供**手动上传参考图**的退路。


### 「和原视频一样」能做到什么程度

| 维度 | 效果 |
|---|---|
| 时长 | Wan 可精确到秒（2–30）；MiniMax 只能就近取 6 或 10；Kling 完全继承参考视频 |
| 分辨率和画幅 | 取**最接近原片短边**的合法档位；画幅比例按宽高比推断，**永远落在 5 个合法枚举内**（不会出现 adaptive） |
| 内容 | 同构图、同机位运动、同节奏、同色调，但**人物全部重新选角** |

**老实说：不是逐像素相同。** 模型的枚举值就这么几个（MiniMax 只有两档时长、两档分辨率），
所以实现的是「**就近取合法值**」，而不是「精确复刻原片参数」。日志里会明确写出每个模型实际用了什么，
不会假装匹配成功。

## 🎭 人物必须换（IP-safe 重制）

这是本项目的核心约束：**重制版里不得出现与原片相同的人物**。

不是「换脸」，而是**重新选角**——把下面这段作为强制约束拼在提示词最前面：

```
[CASTING RULE — MANDATORY]
The output MUST NOT reproduce any person, face, likeness, or identity appearing in the reference video.
Treat the reference video as choreography and camera staging only.
Re-cast every human with a clearly different person: different face, different age,
different ethnicity where possible, different hairstyle, different body type, and different wardrobe.
Do not copy the original subjects' clothing, logos, uniforms, or accessories.
If the result would resemble the original person, change the subject instead of matching it.
```

规则**始终在创作方向之前**，不会被润色结果覆盖。

> 说明：这是**提示词层面的约束**，能显著降低相似度，但不是像素级人脸识别的硬保证。
> 生成后请自行核验；若仍有相似，把「创作方向」写得更具体（例如明确指定人物的年龄/发型/服装），重跑一次。

## ⛔ 为什么整族禁用 Seedance

**结论：本项目主动屏蔽 Seedance 全系（`seedance` / `seedream` / `dreamina`），不做任何兼容。**

两条硬阻塞，都与本应用的输入模式天然冲突：

1. **需要人工签协议**：Seedance 全系必须先在仪表盘签《Asset Library User Agreement》
   （<https://powertokens.ai/assets-library?tab=1>），**没有 API 可代签**。
2. **素材只收 `asset://`**：外部 `http(s)` 会被前置拒绝。要用它必须先 `upload` 换 `asset_id`。

而本应用的输入就是「源视频公网 URL 直接交给 PT 服务端下载」——既没有本地文件可上传，
也不该为了用某个模型给用户加一道「先签名再传素材」的流程。

拦截是三层的：模型链里根本不存在 → 运行时 `isSeedance()` 再跳一次 → 网页端 `SEEDANCE_RE` 过滤 `/v1/models` 列表。

## ⚠️ 源视频必须是「文件直链」

**这是最容易踩的坑。** 本项目把链接交给 PT 服务端去下载，服务端拿到的东西必须**直接是视频文件**。

| 链接类型 | 能用吗 | 原因 |
|---|---|---|
| `https://cdn.xxx.com/a.mp4` | ✅ | 服务端直接拿到 mp4 字节流 |
| `https://www.youtube.com/watch?v=...` | ❌ | 返回的是 HTML 播放页 |
| 抖音 / B站 / 快手 / 小红书 分享页 | ❌ | 同上，且多数需登录 |
| 网盘链接 | ❌ | 需鉴权，服务端无法匿名下载 |

用播放页会得到这个报错（来自 Kling 的 ffprobe）：
```
failed to probe video_url duration: ffprobe probe error:
Invalid data found when processing input
```

**现在页面会在输入时就拦下来**，不会浪费一次提交。你需要自己把视频下载到本地，
放到任意可公开访问的存储（对象存储 / GitHub Releases / 图床），拿到 `.mp4` 直链再贴进来。

> 想用本地文件？目前**不支持**——浏览器里的文件 PT 服务端访问不到。
> 必须先把文件传到公网拿到 URL。

## 工作原理

```
你贴的链接
   │
   ├─► 探测原始参数（网页用 <video> 元数据；CLI 用 ffprobe）→ 时长 / 宽高 / 短边 / 有无音轨
   ├─► 抽参考帧（网页用 canvas.toDataURL；CLI 用 ffmpeg）→ 给 MiniMax / Kling 当首帧
   │
   └─► 按固定链逐个适配并提交
          Wan 2.7 r2v ─失败─► MiniMax Hailuo 2.3 ─失败─► Kling v3 运镜
                 │
                 └─► 轮询至 completed → 拿到成片 URL
```

源视频以「参考视频 URL」交给 PT 服务端下载，**浏览器不下载源文件**（绕开跨域限制）。
只有抽帧这一步需要浏览器真正读取视频——若源站开了 CORS 限制，抽帧会失败，
此时 Wan 与 MiniMax 仍可正常工作（MiniMax 的 image 是可选的），Kling 会被跳过并说明原因。

## 本地使用（浏览器）

1. 直接用浏览器打开 `index.html`，或访问 Pages 站点。
2. 填写 PowerTokens Key（[获取](https://powertokens.ai/zh-Hans/dashboard)）。
3. 粘贴视频链接（**.mp4/.webm/.mov 直链最佳**）。
4. 可选填「创作方向」，点 🚀 开始 Remake。

> **不需要装 ffmpeg。** 浏览器版用 `<video>` + `canvas` 自己完成探测和抽帧。

演示模式：`index.html?mock=1` 可无 Key 跑通完整 UI 流程（用示例视频）。

## 命令行（后台 / 自动化）

`engine.mjs` 与网页逻辑一致，额外支持 ffprobe/ffmpeg（更准，且能处理浏览器读不了的源）。

```bash
# 打印三个模型各自的端点与请求体，不提交、不扣费
node engine.mjs --dry-run --url <链接> --direction "雨夜霓虹街道"

# 真跑
node engine.mjs --url <链接> --key sk-pt-xxxx --direction "雨夜霓虹街道"

# 演示（不需要 Key）
node engine.mjs --mock --url https://example.com/clip.mp4
```

参数：`--dry-run` 只打印 / `--mock` 演示 / `--no-probe` 跳过探测 / `--no-sound` 不要声音 /
`--no-cast-swap` 关闭换角规则（不推荐）/ `--key` 或环境变量 `POWERTOKENS_API_KEY`。

ffmpeg 可选：装了就精确探测 + 抽帧；没装则降级为默认 5s/720P 并明确告警。

- Windows：`winget install --id Gyan.FFmpeg -e`
- macOS：`brew install ffmpeg`
- Ubuntu：`sudo apt install ffmpeg`

## 自测

```bash
node runall.mjs        # 一次跑完全部三套，结果写入 .alltests.txt
node adaptertest.mjs   # 各模型参数适配，59 项
node selftest.mjs      # 引擎契约 + 人物规则 + 降级链路，28 项
node htmltest.mjs      # 网页内联 JS 语法 + 关键逻辑，55 项
```

当前全部通过：**146 / 146**（adaptertest 59 + selftest 30 + htmltest 57）。

### 已验证到什么程度（老实交代）

| 验证项 | 状态 |
|---|---|
| 三个端点的真实字段/枚举/互斥规则 | ✅ **实打实打真接口验过**（见上表） |
| 真实 mp4 的 ffprobe 探测（5s/1280x720/30fps/有音轨/h264） | ✅ 通过 |
| 三模型请求体生成 + 完整降级链 | ✅ 通过（dry-run + mock） |
| 平台播放页拦截（YouTube 等 17 个域名） | ✅ 通过 |
| **真实出片（真的拿到 mp4 成片 URL）** | ✅ **已完成**（2026-10-29，用有效 key 真实扣费跑通两条路径） |
| **完整生产流程（部署版 `engine.mjs` 端到端）** | ✅ ffprobe → LLM 扩写 → 抽帧 → 提交 → `pollPath` 轮询至 `completed 100%` → 成片 |
| **出片质量与原片对比（规格 / SSIM / PSNR / 逐帧）** | ✅ 见 [`compare/quality-report.html`](compare/quality-report.html) |

### 真实出片验证记录（2026-10-29）

用有效 key 真实扣费，多条路径都跑通、拿到成片 URL：

| 路径 | 模型 | 结果 |
|---|---|---|
| 兜底（纯文生，不吃参考视频） | MiniMax-Hailuo-2.3 · 6s 768P | ✅ `task_C3l46miTE1HEAjeBhd2XFz75rySMO7if.mp4` |
| 参考视频重制（首轮） | Wan 2.7 r2v · 2s 720P | ✅ `task_MnlRLMHMZYj8xBij4nzfUaOGQAEfF5ky.mp4` |
| **参考视频重制（完整流程 · 部署版 `engine.mjs` 端到端）** | Wan 2.7 r2v · 5s 720P · 参考=`fixtures/sample.mp4` | ✅ `task_9evJSk3c74LW4O9MNrEW0FMUIFj4J4KL.mp4` |

成片域名：`pub-425ca9cea13d454a907692a0a9f80079.r2.dev/task-results/...`

最后一次「完整流程」运行日志（关键行）：

```
源视频：5s  1280x720  30fps  音轨=有  编码=h264
LLM 扩写：是
已抽取参考帧并转成 data URL（29 KB）
[ok] task_id=task_9evJSk3c74LW4O9MNrEW0FMUIFj4J4KL
轮询 33：status=completed 100%
[ok] 完成：https://.../task_9evJSk3c74LW4O9MNrEW0FMUIFj4J4KL.mp4
```

### 出片质量 vs 原片（实测）

报告：[`compare/quality-report.html`](compare/quality-report.html)（自包含，含 3 组逐帧并排截图）。

复现：

```bash
node tools/quality-compare.mjs --orig fixtures/sample.mp4 --out <成片URL或本地路径> --ffmpeg-dir <含ffmpeg.exe的目录>
```

| 指标 | 原片 | 成片 |
|---|---|---|
| 时长 | 5.00s | 5.04s |
| 分辨率 | 1280x720 | 1280x720 |
| 帧率 | 30fps | 30fps |
| 编码 | h264 / yuv420p | h264 / yuv420p |
| 码率 | 197 kbps | 8.6 Mbps |
| 体积 | 120 KB | 5296 KB |
| **SSIM（结构相似度）** | — | **0.568** |
| **PSNR** | — | **9.03 dB** |

**怎么读**：规格**完全匹配**（分辨率 / 时长 / 帧率 / 编码一致）✅。SSIM / PSNR 偏低是**预期结果**，不是缺陷：
本产品强制换角，且 `fixtures/sample.mp4` 本身是 ffmpeg 测试彩条（合成图案），与原片做像素级比对天然低分。
这两个值的真正作用是确认成片「**有效、完整、未损坏**」。成片经抽帧肉眼确认：同一场景内三镜
（撑伞行走 → 水洼倒影 → 抬头特写），画面连贯、无花屏、无截断，质量达标。

实测踩到的两个真实坑（已修）：
1. **参考视频必须 ≤30s**：W3C 那段 Sintel 预告片 52s，Wan 直接 `duration should be at most 30s`。仓库内置 `fixtures/sample.mp4`（5s）作为可下载参考样例。
2. **轮询端点 bug**：`engine.mjs` 曾用 `built.path`（创建端点 `/v1/videos`）而非 `built.pollPath`（任务端点 `/v1/videos/{id}`）轮询，导致永远拿不到任务状态、10 分钟后误报失败。已修正，并加回归测试（selftest 第 0 组）。

## 法律边界

仅用于你自己拍摄 / 已获授权的视频。不要拿他人版权视频重制后对外分发。
生成的「重制」为同构图、不同人物的原创产物。

## 文件

| 文件 | 说明 |
|------|------|
| `index.html` | 单页 Web 应用（UI + 全部逻辑，内嵌 CSS/JS） |
| `adapters.mjs` | **三模型各自适配器**（端点/字段/枚举/约束，核心逻辑） |
| `probe.mjs` | ffprobe/ffmpeg 探测与抽帧（CLI 用） |
| `engine.mjs` | Node 孪生引擎（固定链 + 自动降级 + 轮询） |
| `adaptertest.mjs` | 适配器单测（59 项） |
| `selftest.mjs` | 引擎自测（28 项） |
| `htmltest.mjs` | 网页自测（55 项） |
| `runall.mjs` | 全量测试入口 |
| `.nojekyll` | 告诉 GitHub Pages 不要忽略下划线文件 |
