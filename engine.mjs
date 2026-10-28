#!/usr/bin/env node
// Video Remake 引擎（服务端孪生版）——与 index.html 浏览器应用逻辑一致。
// 用途：
//   1) 无 Key 自测契约：  node engine.mjs --dry-run --url <链接> --model kling-v2-1-master
//   2) 真跑（agent 后台用）：node engine.mjs --url <链接> --key sk-pt-xxx [--model ...] [--direction ...]
//   3) 演示：            node engine.mjs --mock
// 生成由 PowerTokens 视频模型完成；源视频以「参考视频 URL」交给 PT 服务端下载，浏览器/本机均不碰源文件。
import { writeFileSync } from "node:fs";

const PT_BASE = "https://api.powertokens.ai";
const OUT = "C:\\Users\\admin\\WorkBuddy\\2026-10-27-17-26-05\\video-remake-prototype\\.engine_out.txt";
const L = [];
const log = (s, c) => { L.push((c ? "[" + c + "] " : "") + s); };

function videoProvider(model) {
  const m = model.toLowerCase();
  if (m.includes("seedance")) return "seedance";
  if (m.includes("h3") || m === "minimax-h3") return "minimax-h3";
  if (m.includes("hailuo")) return "hailuo";
  if (m.startsWith("kling")) return "kling";
  if (m.includes("happyhorse")) return "happyhorse";
  if (m.startsWith("vidu")) return "vidu";
  if (m.startsWith("wan")) return "wan";
  return "seedance";
}
function supportsRefVideo(model) { return ["kling", "wan", "minimax-h3", "seedance"].includes(videoProvider(model)); }

const DIRECT_EXT = /\.(mp4|webm|mov|m4v|ogg)(\?|#|$)/i;
function resolveSourceUrl(raw) {
  const u = (raw || "").trim();
  if (!u) throw new Error("链接为空");
  return { url: u, direct: DIRECT_EXT.test(u) || /^https?:\/\/.+\.(mp4|webm|mov|m4v)/i.test(u) };
}

function buildBody(provider, model, sourceUrl, prompt, opts) {
  const dur = parseInt(opts.duration, 10) || 5;
  const res = opts.resolution.includes("1080") ? "1080p" : "720p";
  if (provider === "kling") {
    return { path: "/kling/v1/videos/motion-control", pollPath: "/kling/v1/videos/motion-control",
      body: { model_name: model, mode: res.includes("1080") ? "pro" : "std", video_url: sourceUrl, prompt, sound: opts.sound ? "on" : "off" } };
  }
  if (provider === "wan") {
    return { path: "/v1/videos", pollPath: "/v1/videos",
      body: { model, prompt, seconds: String(dur), size: res.includes("1080") ? "1080P" : "720P", media: [{ type: "reference_video", url: sourceUrl }] } };
  }
  if (provider === "minimax-h3") {
    return { path: "/minimax/v2/video_generation", pollPath: "/minimax/v2/query/video_generation",
      body: { model, content: [{ type: "text", text: prompt }, { type: "video_url", video_url: { url: sourceUrl }, role: "reference_video" }], resolution: res.includes("1080") ? "1080P" : "768P", duration: dur } };
  }
  if (provider === "seedance") {
    return { path: "/byteplus/api/v3/contents/generations/tasks", pollPath: "/byteplus/api/v3/contents/generations/tasks",
      body: { model, content: [{ type: "text", text: prompt }, { type: "video_url", video_url: { url: sourceUrl }, role: "reference_video" }], duration: dur, resolution: res, ratio: "adaptive" } };
  }
  throw new Error("不支持参考视频的模型：" + model);
}

function extractUrl(data, provider) {
  const c = [data?.url, data?.content?.video_url, data?.data?.task_result?.videos?.[0]?.url,
    data?.data?.task_result?.videos?.[0]?.watermark_url, data?.metadata?.url, data?.video_url, data?.data?.url];
  return c.find(Boolean) || null;
}

async function main() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "true";
      args.set(k, v);
    }
  }
  const MOCK = args.has("mock");
  const DRY = args.has("dry-run");
  const key = args.get("key") || "";
  const url = args.get("url") || "";
  const model = args.get("model") || "kling-v2-1-master";
  const direction = args.get("direction") || "";
  const duration = args.get("duration") || "5";
  const resolution = args.get("resolution") || "720p";
  const sound = args.has("sound");

  if (!supportsRefVideo(model)) { log("模型不支持参考视频：" + model, "err"); return flush(); }

  const { url: src, direct } = resolveSourceUrl(url);
  log("源视频：" + src + (direct ? "（直链）" : "（非直链，PT 服务端尝试下载）"));
  const provider = videoProvider(model);
  log("供应商：" + provider + "  模型：" + model);

  // 提示词
  let prompt;
  if (!direction.trim()) prompt = "Recreate in similar visual style with original non-infringing content.";
  else if (MOCK || DRY) prompt = (DRY ? "[dry] " : "[mock] ") + direction.trim();
  else {
    const r = await fetch(PT_BASE + "/v1/chat/completions", {
      method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-pro",
        messages: [{ role: "system", content: "把用户的中文创作方向扩写成英文视频生成提示词，只输出提示词。" },
                   { role: "user", content: `参考视频：${src}\n方向：${direction.trim()}` }], max_tokens: 600 }),
    });
    const j = await r.json();
    prompt = j.choices?.[0]?.message?.content?.trim() || direction.trim();
  }
  log("提示词：" + prompt.slice(0, 200));

  const built = buildBody(provider, model, src, prompt, { duration, resolution, sound });
  log("提交端点：POST " + PT_BASE + built.path);
  log("请求体：" + JSON.stringify(built.body));

  if (DRY) { log("（dry-run 结束，未真正提交）", "ok"); return flush(); }

  if (MOCK) {
    log("演示模式：模拟生成成功", "ok");
    log("结果：https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4");
    return flush();
  }

  // 真实提交
  const sub = await fetch(PT_BASE + built.path, {
    method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(built.body),
  });
  const sj = await sub.json().catch(() => ({}));
  if (!sub.ok) { log("提交失败 " + sub.status + "：" + JSON.stringify(sj).slice(0, 300), "err"); return flush(); }
  const taskId = sj.data?.task_id || sj.task_id || sj.id;
  log("task_id=" + taskId, "ok");
  if (!taskId) { log("无 task_id：" + JSON.stringify(sj).slice(0, 200), "err"); return flush(); }

  // 轮询
  let resultUrl = null;
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const pr = await fetch(PT_BASE + built.pollPath + "/" + taskId, { headers: { Authorization: "Bearer " + key } });
    const pd = await pr.json().catch(() => ({}));
    const st = pd.data?.task_status || pd.task_status || pd.status || pd.state;
    const prog = typeof pd.progress === "number" ? pd.progress : null;
    log("轮询 " + (i + 1) + "：" + st + (prog != null ? " " + prog + "%" : ""));
    const low = String(st).toLowerCase();
    if (["succeed", "succeeded", "completed", "success"].includes(low)) { resultUrl = extractUrl(pd, provider); break; }
    if (["failed", "error", "cancelled", "expired"].includes(low)) { log("生成失败：" + JSON.stringify(pd).slice(0, 200), "err"); return flush(); }
  }
  if (resultUrl) { log("🎉 重制完成：" + resultUrl, "ok"); }
  else log("轮询超时", "err");
  flush();
}
function flush() { writeFileSync(OUT, L.join("\n") + "\n", "utf-8"); }

main().catch((e) => { log("FATAL: " + e.message, "err"); flush(); });
