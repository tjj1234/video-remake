# 🎬 Video Remake 引擎（GitHub Pages 版）

复刻自 **Media.io Viral Studio** 的「贴视频链接 → 一键重制」能力。纯前端单页应用，部署在 GitHub Pages，**无需任何后端**。

- 输入：视频链接 + 你的 PowerTokens Key
- 输出：同构图、同节奏，但**人物必换**的原创重制视频
- Key 只存在你浏览器 `localStorage`，**不经过任何第三方服务器**
- 源视频以「参考视频 URL」交给 PowerTokens 服务端下载并做动作/风格迁移，**浏览器不下载源文件**（绕开跨域限制）

## 工作原理

```
你贴的链接 ──► POST /v1/videos (media=[{type:reference_video, url}]) ──► PT 服务端下载源视频并重制
                                                                                    │
       结果视频 URL ◄── GET /v1/videos/{id} 轮询（每 10s，上限 10min）◄──────────────┘
```

### PT 契约（以官方 skill 为准）

契约来源：<https://github.com/tjj1234/powertokens-video>（`pt_video.py`，v0.4.1）。

**所有视频模型统一走同一个网关端点**，不按厂商拼不同路径：

| 项 | 值 |
|---|---|
| 提交 | `POST https://api.powertokens.ai/v1/videos` |
| 轮询 | `GET /v1/videos/{id}`，每 10s，`status ∈ succeeded/completed` 为完成 |
| 参考视频 | `media: [{ type: "reference_video", url: <你的链接> }]` |
| 时长 | `seconds` 必须传**字符串**（服务端为 enum\<string\>） |
| 分辨率 | `size: "480P" / "720P" / "1080P"`（大写） |
| 结果地址 | `task.metadata.url` 或 `metadata.content_url` |

> ⚠️ 早期版本曾按厂商拼 `/kling/v1/videos/motion-control`、`/minimax/v2/video_generation`、
> `/byteplus/api/v3/...` 三条路径——**这是错的**，PT 是统一网关，厂商路径会 404/不支持。已全部改为 `/v1/videos`。

### 哪些模型能做「参考视频重制」

| 模型 | 支持参考视频 | 说明 |
|---|---|---|
| `kling-v2-1-master` | ✅ | 动作/走位迁移最稳，默认首选 |
| `kling-video-o1` | ✅ | 性价比高 |
| `kling-v3` | ✅ | — |
| `wan2.7-r2v` | ✅ | Wan 参考视频 |
| `wan3.0-video` | ❌ | 不收参考视频 |
| `seedance-*` | ❌ | 媒体只收 `asset://`，外部 http(s) 被前置拒绝 |

## 🎭 人物必须换（IP-safe 重制）

这是本项目的核心约束：**重制版里不得出现与原片相同的人物**。

实现方式不是「换脸」，而是**重新选角**——把下面这段作为强制约束拼在提示词最前面：

```
[CASTING RULE — MANDATORY]
The output MUST NOT reproduce any person, face, likeness, or identity appearing in the reference video.
Treat the reference video as choreography and camera staging only.
Re-cast every human with a clearly different person: different face, different age,
different ethnicity where possible, different hairstyle, different body type, and different wardrobe.
Do not copy the original subjects' clothing, logos, uniforms, or accessories.
If the result would resemble the original person, change the subject instead of matching it.
```

界面上的「强制更换人物」开关默认勾选。规则始终在创作方向之前，不会被润色结果覆盖。

> 说明：这是**提示词层面的约束**，能显著降低相似度，但不是像素级人脸识别的硬保证。
> 生成后请自行核验；若仍有相似，把「创作方向」写得更具体（例如明确指定人物的年龄/发型/服装），重跑一次。

## 本地使用（浏览器）

1. 克隆后直接用浏览器打开 `index.html`，或访问 Pages 站点。
2. 填写 PowerTokens Key（[获取](https://powertokens.ai/zh-Hans/dashboard)）。
3. 粘贴视频链接（**.mp4/.webm/.mov 直链最佳**；平台分享页 PT 服务端会尝试直接下载，失败请换直链）。
4. 可选填「创作方向」，点 🚀 开始 Remake。

演示模式：访问 `index.html?mock=1` 可无 Key 跑通完整 UI 流程（用示例视频）。

## 命令行（无浏览器 / 后台自测）

`engine.mjs` 与网页逻辑完全一致，可在 Node 里跑：

```bash
# 无 Key 验证请求契约（打印将发送的端点+请求体，不真正提交、不扣费）
node engine.mjs --dry-run --url <链接> --model kling-v2-1-master

# 真跑（需要 Key）
node engine.mjs --url <链接> --key sk-pt-xxxx --model kling-v2-1-master --direction "雨夜霓虹街道，短发亚裔女性在跳舞" --sound

# 演示
node engine.mjs --mock --url https://example.com/clip.mp4
```

## 自测

```bash
node selftest.mjs   # 引擎契约 + 人物规则，21 项
node htmltest.mjs   # 网页内联 JS 语法 + 关键逻辑，17 项
```

## 法律边界

仅用于你自己拍摄 / 已获授权的视频。不要拿他人版权视频重制后对外分发。生成的「重制」为同构图、不同人物的原创产物。

## 文件

| 文件 | 说明 |
|------|------|
| `index.html` | 单页 Web 应用（UI + 全部逻辑，内嵌 CSS/JS） |
| `engine.mjs` | Node 孪生引擎（与网页同契约，用于后台/CLI 自测） |
| `selftest.mjs` | 引擎自测（21 项） |
| `htmltest.mjs` | 网页自测（17 项） |
| `.nojekyll` | 告诉 GitHub Pages 不要忽略下划线文件 |
