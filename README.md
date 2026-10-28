# 🎬 Video Remake 引擎（GitHub Pages 版）

复刻自 **Media.io Viral Studio** 的「贴视频链接 → 一键重制」能力。纯前端单页应用，部署在 GitHub Pages，**无需任何后端**。

- 输入：视频链接 + 你的 PowerTokens Key
- 输出：同风格、原创内容的重制视频
- Key 只存在你浏览器 `localStorage`，**不经过任何第三方服务器**
- 源视频以「参考视频 URL」交给 PowerTokens 服务端下载并做动作/风格迁移，**浏览器不下载源文件**（绕开跨域限制）

## 工作原理

```
你贴的链接 ──► PT 视频模型(refVideo=链接, prompt=创作方向) ──► PT 服务端下载源视频+重制 ──► 返回新视频 URL
```

关键点（已通过逆向 pt CLI 验证）：
- PowerTokens 网关 `api.powertokens.ai` **放开浏览器跨域（CORS `*`）**，所以纯静态站点能直接调。
- `refVideo` / `reference_video` 接受公网 URL，由 PT 服务端下载——浏览器无需碰源视频。
- 支持「参考视频」的供应商：Kling（动作迁移）、Wan（r2v）、MiniMax-H3、Seedance。

## 本地使用（浏览器）

1. 克隆后直接用浏览器打开 `index.html`，或访问 Pages 站点。
2. 填写 PowerTokens Key（[获取](https://powertokens.ai/zh-Hans/dashboard)）。
3. 粘贴视频链接（**.mp4/.webm/.mov 直链最佳**；平台分享页 PT 服务端会尝试直接下载，失败请换直链）。
4. 可选填「创作方向」，点 🚀 开始 Remake。

演示模式：访问 `index.html?mock=1` 可无 Key 跑通完整 UI 流程（用示例视频）。

## 命令行（无浏览器 / 后台自测）

`engine.mjs` 与网页逻辑完全一致，可在 Node 里跑：

```bash
# 无 Key 验证请求契约（打印将发送的端点+请求体，不真正提交）
node engine.mjs --dry-run --url <链接> --model kling-v2-1-master

# 真跑（需要 Key）
node engine.mjs --url <链接> --key sk-pt-xxxx --model kling-v2-1-master --direction "橘猫煮咖啡" --sound

# 演示
node engine.mjs --mock
```

## 法律边界

仅用于你自己拍摄 / 已获授权的视频。不要拿他人版权视频重制后对外分发。生成的「重制」为同风格、不同内容的原创产物。

## 文件

| 文件 | 说明 |
|------|------|
| `index.html` | 单页 Web 应用（UI + 全部逻辑，内嵌 CSS/JS） |
| `engine.mjs` | Node 孪生引擎（与网页同契约，用于后台/CLI 自测） |
| `.nojekyll` | 告诉 GitHub Pages 不要忽略下划线文件 |
