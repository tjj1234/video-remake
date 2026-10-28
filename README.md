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
| 模型字段 | `model` | `model` | **`model_name`** |
| 参考视频 | `media:[{type:"reference_video", url}]` | ❌ 不收视频 | **`video_url`** |
| 必填图片 | ❌ | **`image`（首帧，URL 或 DataURL）** | **`image_url`（人物图）** |
| 时长 | `seconds` 字符串 2–30（有视频输入时 输入+输出 ≤30） | `seconds` **仅 `"6"` / `"10"`** | ❌ **无此字段**，继承参考视频 |
| 分辨率 | `size` ∈ `480P`/`720P`/`1080P` | `size` ∈ **`768P`/`1080P`（没有 720P）** | ❌ 只有 `mode` ∈ `std`(720P)/`pro`(1080P) |
| 画幅 | `ratio` ∈ `adaptive`/`16:9`/`4:3`/`1:1`/`3:4`/`9:16` | ❌ 由 image 决定 | ❌ 由参考视频决定 |
| 声音 | `generate_audio` bool | ❌ | `keep_original_sound` ∈ `"yes"`/`"no"` |
| 其他必填 | — | — | **`character_orientation`** ∈ `image`(参考视频≤10s)/`video`(≤30s) |
| 提示词上限 | — | 2000 字 | 2500 字 |
| 返回格式 | 标准 `{id, status}` | 标准 `{id, status}` | **Kling 原生 `{code, message, data:{task_id, task_status}}`** |

所以「换模型」绝不是换个 `model` 字段名那么简单——**换错端点直接 404，换错枚举值直接 400**。
全部差异封装在 `adapters.mjs` 的 `fit()` 里，由 `adaptertest.mjs` 的 44 条断言守住。

> 早期文档曾说「所有视频模型统一走 `/v1/videos`」——**那是错的**。Kling 运镜必须走厂商原生路径。

### 「和原视频一样」能做到什么程度

| 维度 | 效果 |
|---|---|
| 时长 | Wan 可精确到秒（2–30）；MiniMax 只能就近取 6 或 10；Kling 完全继承参考视频 |
| 分辨率和画幅 | 取**最接近原片短边**的合法档位；画幅比例按宽高比推断（容差 14%，超出则 Wan 用 `adaptive`） |
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
此时 Wan 仍可正常工作（它不需要图片），MiniMax / Kling 会被跳过并说明原因。

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
node adaptertest.mjs   # 各模型参数适配，44 项
node selftest.mjs      # 引擎契约 + 人物规则 + 降级链路，28 项
node htmltest.mjs      # 网页内联 JS 语法 + 关键逻辑，32 项
```

当前全部通过：**104 / 104**。

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
| `adaptertest.mjs` | 适配器单测（44 项） |
| `selftest.mjs` | 引擎自测（28 项） |
| `htmltest.mjs` | 网页自测（32 项） |
| `runall.mjs` | 全量测试入口 |
| `.nojekyll` | 告诉 GitHub Pages 不要忽略下划线文件 |
