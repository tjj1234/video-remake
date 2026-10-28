#!/usr/bin/env node
// Video Remake 引擎（服务端孪生版）—— 与 index.html 浏览器应用逻辑严格一致。
//
// PT 契约以官方 skill 为准（https://github.com/tjj1234/powertokens-video）：
//   所有视频模型统一走 POST /v1/videos，轮询 GET /v1/videos/{id}
//   参考视频 = media:[{type:"reference_video", url}]
//   注意：不要按厂商拼 /kling/... /minimax/... /byteplus/... 等路径，PT 是统一网关。
//
// 用法：
//   node engine.mjs --dry-run --url <链接>                       # 只打印请求体，不扣费
//   node engine.mjs --url <链接> --key sk-pt-xxx [--model ...]    # 真跑
//   node engine.mjs --mock                                       # 演示成功路径
import { writeFileSync, appendFileSync } from "node:fs";

const PT_BASE = "https://api.powertokens.ai";
const OUT_DIR = "C:\\Users\\admin\\WorkBuddy\\2026-10-27-17-26-05\\video-remake-prototype";
const OUT = OUT_DIR + "\\.engine_out.txt";
const L = [];
const log = (s, c) => { L.push((c ? "[" + c + "] " : "") + s); };

// ---------- 模型能力表 ----------
// supportsRefVideo: 该模型是否接受 media[type=reference_video]
// seedance 系：媒体只收 asset://，外部 http(s) 会被前置拒绝 → 不能直接用源视频 URL
const MODELS = {
  "kling-v2-1-master": { ref: true,  type: "video", note: "Kling 动作/参考视频，表现最稳" },
  "kling-video-o1":    { ref: true,  type: "video", note: "Kling O1，性价比高" },
  "kling-v3":          { ref: true,  type: "video", note: "Kling v3" },
  "wan2.7-r2v":        { ref: true,  type: "video", note: "Wan r2v（参考视频）" },
  "wan3.0-video":      { ref: false, type: "video", note: "Wan3.0 纯文生/图生，不收参考视频" },
  "seedance-1-5-pro-251215": { ref: false, type: "seedance", note: "需 asset:// + 签协议" },
};

// 供应商族 → 是否支持 ref video（用于用户手填模型名时的兜底判断）
function supportsRefVideo(model) {
  const m = String(model || "").toLowerCase();
  if (MODELS[m]) return MODELS[m].ref;
  if (m.includes("seedance")) return false;      // 媒体只收 asset://
  if (m.startsWith("wan3")) return false;
  return true;                                    // kling / wan(非3.0) / hailuo / vidu 默认支持
}
function modelType(model) {
  const m = String(model || "").toLowerCase();
  if (MODELS[m]) return MODELS[m].type;
  if (m.includes("seedance")) return "seedance";
  if (m.includes("image") || m.includes("seedream") || m.includes("qwen-image")) return "image";
  return "video";
}

// ---------- 源地址解析 ----------
// PT 服务端会自行下载 http(s) 源视频，因此页面链接（非直链）也能提交；
// 但提取不到直链时生成质量会下降 → 前端会提示用户优先贴直链。
const DIRECT_EXT = /\.(mp4|webm|mov|m4v|ogg)(\?|#|$)/i;
function resolveSourceUrl(raw) {
  const u = String(raw || "").trim();
  if (!u) throw new Error("源视频链接为空");
  if (!/^https?:\/\//i.test(u)) throw new Error("链接必须以 http:// 或 https:// 开头");
  return { url: u, direct: DIRECT_EXT.test(u) };
}

// ---------- 请求体构造（全模型统一）----------
function buildBody(model, sourceUrl, prompt, opts = {}) {
  const dur = Math.min(30, Math.max(2, parseInt(opts.duration, 10) || 5));
  const resRaw = String(opts.resolution || "720p").toUpperCase();
  const size = resRaw.includes("1080") ? "1080P" : resRaw.includes("480") ? "480P" : "720P";
  const useRef = supportsRefVideo(model) && !!sourceUrl;

  const body = {
    model,
    prompt,
    size,
    ratio: opts.ratio || "adaptive",
    seconds: String(dur),                       // 服务端为 enum<string>，必须字符串
    generate_audio: opts.sound !== false,
    prompt_extend: true,
    watermark: !!opts.watermark,
  };
  if (useRef) {
    // 关键：参考视频走 media 数组，不被当作首帧
    body.media = [{ type: "reference_video", url: sourceUrl }];
  }
  return { path: "/v1/videos", pollPath: "/v1/videos/{id}", body, useRef };
}

function extractUrl(task) {
  const meta = task?.metadata || {};
  return meta.url || meta.content_url || task?.url || null;
}

// ---------- 人物替换规则（IP-safe 重制）----------
// 核心约束：重制版里不得出现与原片相同的人物形象。
// 做法不是「换脸」而是「重新选角」——生成提示词里显式声明不同的人物特征，并禁止复现原人物。
const PERSONA_RULE = [
  "[CASTING RULE — MANDATORY]",
  "The output MUST NOT reproduce any person, face, likeness, or identity appearing in the reference video.",
  "Treat the reference video as choreography/staging only. Re-cast every human with a clearly different person:",
  "different face, different age, different ethnicity where possible, different hairstyle, different body type, different wardrobe.",
  "Do not copy clothing, logos, uniforms, or accessories of the original subjects.",
  "If a likeness match would occur, change the subject instead of matching it.",
].join(" ");

function buildPrompt(direction, opts = {}) {
  const dir = String(direction || "").trim();
  // 人物规则默认开启（用户要求：有人物必须不能相同人物）
  const cast = PERSONA_RULE;
  if (!dir) {
    return cast + " Recreate the reference video's composition, camera movement, pacing and mood, but with entirely new, non-infringing content and different people.";
  }
  return cast + " Creative direction: " + dir;
}

// ---------- 主流程 ----------
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
  const key = args.get("key") || process.env.POWERTOKENS_API_KEY || "";
  const url = args.get("url") || "";
  const model = args.get("model") || "kling-v2-1-master";
  const direction = args.get("direction") || "";
  const duration = args.get("duration") || "5";
  const resolution = args.get("resolution") || "720p";
  const sound = args.has("sound");
  const ratio = args.get("ratio") || "adaptive";

  log("=== Video Remake Engine ===");
  log("模型：" + model + "  类型：" + modelType(model) + (MODELS[model] ? "  (" + MODELS[model].note + ")" : ""));

  if (modelType(model) === "image") { log("这是图片模型，不能用于视频重制：" + model, "err"); return flush(); }

  const { url: src, direct } = resolveSourceUrl(url);
  log("源视频：" + src);
  log("直链判定：" + (direct ? "是直链" : "非直链（PT 服务端尝试下载，可能失败）"));

  if (!supportsRefVideo(model)) {
    log("该模型不接受参考视频（reference_video），无法做「同构图重制」：" + model, "err");
    log("建议改用 kling-v2-1-master / kling-video-o1 / wan2.7-r2v", "err");
    return flush();
  }

  let prompt = buildPrompt(direction);
  // 真实模式下用 LLM 把中文方向扩写成英文提示词，但人物规则强制拼在最前面
  if (!DRY && !MOCK && direction.trim() && key) {
    try {
      const r = await fetch(PT_BASE + "/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          messages: [
            { role: "system", content: "You expand a creator's Chinese direction into a concise English video-generation prompt. Describe subject, action, camera, lighting, mood. Never describe matching a reference person's face. Output the prompt only." },
            { role: "user", content: "Direction: " + direction.trim() },
          ],
          max_tokens: 600,
        }),
      });
      const j = await r.json();
      const expanded = j.choices?.[0]?.message?.content?.trim();
      if (expanded) prompt = buildPrompt(expanded);   // 仍强制带上人物规则
      log("LLM 扩写：是");
    } catch (e) {
      log("LLM 扩写失败，用原始方向：" + e.message, "warn");
    }
  }
  log("提示词：" + prompt);

  const built = buildBody(model, src, prompt, { duration, resolution, sound, ratio });
  log("提交：POST " + PT_BASE + built.path);
  log("请求体：" + JSON.stringify(built.body, null, 2));

  if (DRY) { log("dry-run 结束，未提交、未扣费", "ok"); return flush(); }

  if (MOCK) {
    log("演示模式：模拟成功", "ok");
    log("结果：https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4");
    return flush();
  }

  if (!key) { log("缺少 API Key（--key 或 POWERTOKENS_API_KEY）", "err"); return flush(); }

  // 提交
  const sub = await fetch(PT_BASE + built.path, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(built.body),
  });
  const sj = await sub.json().catch(() => ({}));
  if (!sub.ok) { log("提交失败 HTTP " + sub.status + "：" + JSON.stringify(sj).slice(0, 500), "err"); return flush(); }
  const taskId = sj.id || sj.task_id || sj.data?.id || sj.data?.task_id;
  if (!taskId) { log("响应无 task_id：" + JSON.stringify(sj).slice(0, 300), "err"); return flush(); }
  log("task_id=" + taskId, "ok");

  // 轮询（最多 10 分钟）
  const deadline = Date.now() + 600000;
  let resultUrl = null, lastStatus = "";
  let i = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10000));
    i++;
    const pr = await fetch(PT_BASE + "/v1/videos/" + taskId, { headers: { Authorization: "Bearer " + key } });
    const pd = await pr.json().catch(() => ({}));
    const st = String(pd.status || "").toLowerCase();
    lastStatus = st;
    log("轮询 " + i + "：status=" + st + (pd.progress != null ? " " + pd.progress + "%" : ""));
    if (st === "succeeded" || st === "completed") { resultUrl = extractUrl(pd); break; }
    if (st === "failed" || st === "cancelled") {
      log("生成失败：" + JSON.stringify(pd.error || pd.metadata || pd).slice(0, 400), "err");
      return flush();
    }
  }
  if (resultUrl) log("重制完成：" + resultUrl, "ok");
  else log("轮询超时，最后状态=" + lastStatus, "err");
  flush();
}

function flush() { writeFileSync(OUT, L.join("\n") + "\n", "utf-8"); }

main().catch((e) => { log("FATAL: " + e.message, "err"); flush(); process.exitCode = 1; });
