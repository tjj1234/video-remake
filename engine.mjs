#!/usr/bin/env node
// Video Remake 引擎 —— 模型固定 + 多适配器 + 自动降级
//
// 设计原则（用户要求）：
//   1. 模型由代码固定，用户不选；按 MODEL_CHAIN 优先级自动尝试，失败即降级下一个
//   2. 每个模型有自己的参数约束，由 adapters.mjs 里的独立适配器负责翻译
//   3. 重制尽量匹配原视频的真实时长与尺寸（先 ffprobe 探测源视频）
//   4. 人物必换（CASTING RULE 强制前置）
//   5. Seedance 全系禁用（需 asset:// + 签协议）
//
// 用法：
//   node engine.mjs --dry-run --url <链接>              # 只打印各模型将发送的请求体，不扣费
//   node engine.mjs --url <链接> --key sk-pt-xxx        # 真跑（自动选模型+降级）
//   node engine.mjs --mock                              # 演示成功路径
import { writeFileSync, existsSync } from "node:fs";
import { MODEL_CHAIN, getAdapter, PT_BASE } from "./adapters.mjs";
import { probeVideo, extractFrame, findFfmpeg } from "./probe.mjs";

const OUT_DIR = "C:\\Users\\admin\\WorkBuddy\\2026-10-27-17-26-05\\video-remake-prototype";
const OUT = OUT_DIR + "\\.engine_out.txt";
const L = [];
const log = (s, c) => { L.push((c ? "[" + c + "] " : "") + s); };

// ---------- Seedance 黑名单（用户要求回避）----------
const SEEDANCE_RE = /seedance|seedream|\bdreamina\b/i;
const isSeedance = (m) => SEEDANCE_RE.test(String(m || ""));

// ---------- 人物换角规则 ----------
const PERSONA_RULE = [
  "[CASTING RULE — MANDATORY]",
  "The output MUST NOT reproduce any person, face, likeness, or identity appearing in the reference video.",
  "Treat the reference video as choreography and camera staging only. Re-cast every human with a clearly different person:",
  "different face, different age, different ethnicity where possible, different hairstyle, different body type, different wardrobe.",
  "Do not copy clothing, logos, uniforms, or accessories of the original subjects.",
  "If a likeness match would occur, change the subject instead of matching it.",
].join(" ");

function buildPrompt(direction, swapCast = true) {
  const dir = String(direction || "").trim();
  const core = dir || "Recreate the reference video's composition, camera movement, pacing and color mood, but with entirely new, non-infringing content.";
  return swapCast ? PERSONA_RULE + " Creative direction: " + core : core;
}

// ---------- 源地址 ----------
const DIRECT_EXT = /\.(mp4|webm|mov|m4v|avi|mkv|flv)(\?|#|$)/i;
// 平台分享页返回的是 HTML，服务端 ffprobe 会报 "Invalid data found when processing input"
const PAGE_HOSTS = [
  ["youtube.com", "YouTube"], ["youtu.be", "YouTube"],
  ["bilibili.com", "B站"], ["b23.tv", "B站"],
  ["douyin.com", "抖音"], ["iesdouyin.com", "抖音"],
  ["kuaishou.com", "快手"], ["xiaohongshu.com", "小红书"],
  ["xhslink.com", "小红书"], ["instagram.com", "Instagram"],
  ["tiktok.com", "TikTok"], ["twitter.com", "X"], ["x.com", "X"],
  ["facebook.com", "Facebook"], ["vimeo.com", "Vimeo"],
  ["weibo.com", "微博"], ["ixigua.com", "西瓜视频"],
];
function detectPageHost(raw) {
  try {
    const h = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
    for (const [dom, name] of PAGE_HOSTS) if (h === dom || h.endsWith("." + dom)) return name;
  } catch {}
  return null;
}
function resolveSourceUrl(raw) {
  const u = String(raw || "").trim();
  if (!u) throw new Error("源视频链接为空");
  if (!/^https?:\/\//i.test(u)) throw new Error("链接必须以 http:// 或 https:// 开头");
  const page = detectPageHost(u);
  if (page) {
    throw new Error(
      `这是${page}的播放页面，不是视频文件直链。服务端只能下载 .mp4/.webm 直链，` +
      `拿网页去解析会报 "Invalid data found"。请改用视频文件的直接链接。`
    );
  }
  return { url: u, direct: DIRECT_EXT.test(u) };
}

function extractUrl(task) {
  const meta = task?.metadata || {};
  return meta.url || meta.content_url || task?.url || null;
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
  const direction = args.get("direction") || "";
  const sound = args.has("sound");
  const swapCast = !args.has("no-cast-swap");
  const noProbe = args.has("no-probe");

  log("=== Video Remake Engine ===");
  log("模型策略：固定 " + MODEL_CHAIN.map((a) => a.label).join(" → ") + "（失败自动降级）");

  const { url: src, direct } = resolveSourceUrl(url);
  log("源视频：" + src);
  log("直链判定：" + (direct ? "是直链" : "非直链（PT 服务端尝试下载，可能失败）"));

  // ---------- 1. 探测源视频（时长/尺寸）----------
  let meta;
  if (noProbe) {
    log("已跳过探测（--no-probe），使用默认 5s / 720P", "warn");
    meta = { duration: 5, width: 0, height: 0, shortSide: 720, fps: 0, hasAudio: true };
  } else {
    try {
      log("探测源视频（ffprobe）…");
      meta = probeVideo(src);
      log(`源视频：${meta.duration}s  ${meta.width}x${meta.height}  ${meta.fps}fps  音轨=${meta.hasAudio ? "有" : "无"}  编码=${meta.codec}`, "ok");
    } catch (e) {
      log("探测失败：" + e.message, "warn");
      log("降级为默认参数：5s / 720P（时长尺寸将无法匹配原片）", "warn");
      meta = { duration: 5, width: 0, height: 0, shortSide: 720, fps: 0, hasAudio: true };
    }
  }

  // ---------- 2. 提示词 ----------
  let prompt = buildPrompt(direction, swapCast);
  if (!DRY && !MOCK && direction.trim() && key) {
    try {
      const r = await fetch(PT_BASE + "/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          messages: [
            { role: "system", content: "You expand a creator's Chinese direction into a concise English video-generation prompt. Describe subject, action, camera, lighting, mood. Never describe copying a reference person's face or identity. Output the prompt only." },
            { role: "user", content: "Direction: " + direction.trim() },
          ],
          max_tokens: 600,
        }),
      });
      const j = await r.json();
      const expanded = j.choices?.[0]?.message?.content?.trim();
      if (expanded) prompt = buildPrompt(expanded, swapCast);
      log("LLM 扩写：是");
    } catch (e) {
      log("LLM 扩写失败，用原始方向：" + e.message, "warn");
    }
  }
  log("换角规则：" + (swapCast ? "已启用（强制）" : "已关闭（不建议）"), swapCast ? "ok" : "warn");

  // ---------- 3. 抽帧（仅给需要 image 的模型用）----------
  let framePath = null;
  let imageUrl = null;   // 需要公网可访问，dry-run 用占位
  if (!DRY && !MOCK && findFfmpeg()) {
    try {
      framePath = OUT_DIR + "\\.ref_frame.jpg";
      extractFrame(src, framePath, Math.min(0.5, (meta.duration || 1) / 2));
      log("已抽取参考帧：" + framePath);
    } catch (e) {
      log("抽帧失败：" + e.message, "warn");
    }
  }

  // ---------- 4. 逐个模型构造并（可选）提交 ----------
  const attempts = [];
  for (const adapter of MODEL_CHAIN) {
    if (isSeedance(adapter.id)) continue;   // 双保险

    let built;
    try {
      built = adapter.fit(meta, prompt, {
        sourceUrl: src, duration: meta.duration, sound,
        imageUrl: imageUrl || (DRY ? "https://example.com/ref_frame.jpg" : framePath),
      });
    } catch (e) {
      log(`[${adapter.label}] 参数适配失败，跳过：${e.message}`, "warn");
      attempts.push({ model: adapter.id, ok: false, reason: e.message });
      continue;
    }

    const a = built.applied || {};
    log("");
    log(`--- ${adapter.label} (${adapter.id}) ---`);
    log(a.note || `参数适配：时长=${a.dur ?? "由源视频决定"}s  尺寸=${a.size || a.mode || "默认"}${a.charOrient ? "  朝向=" + a.charOrient : ""}`);
    log("端点：POST " + PT_BASE + built.path);
    log("请求体：" + JSON.stringify(built.body, null, 2));

    if (DRY) { attempts.push({ model: adapter.id, ok: true, dry: true }); continue; }
    if (MOCK) {
      attempts.push({ model: adapter.id, ok: true, mock: true,
        url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4" });
      break;
    }
    if (!key) { log("缺少 API Key", "err"); return flush(1); }

    // 提交
    try {
      const sub = await fetch(PT_BASE + built.path, {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(built.body),
      });
      const sj = await sub.json().catch(() => ({}));
      if (!sub.ok) {
        const msg = `提交失败 HTTP ${sub.status}：${JSON.stringify(sj).slice(0, 300)}`;
        log(msg, "err");
        attempts.push({ model: adapter.id, ok: false, reason: msg });
        continue;   // 降级到下一个
      }
      const taskId = sj.id || sj.task_id || sj.data?.id || sj.data?.task_id || sj.data?.task_id;
      if (!taskId) {
        log("响应无 task_id，降级下一个", "err");
        attempts.push({ model: adapter.id, ok: false, reason: "no task_id" });
        continue;
      }
      log("task_id=" + taskId, "ok");

      // 轮询
      const pollBase = built.path.replace("{id}", taskId);
      const deadline = Date.now() + 600000;
      let resultUrl = null, lastStatus = "";
      let n = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10000));
        n++;
        const pr = await fetch(PT_BASE + pollBase, { headers: { Authorization: "Bearer " + key } });
        const pd = await pr.json().catch(() => ({}));
        // 统一取状态：OpenAI 风格 status，或 Kling 风格 data.task_status
        const st = String(pd.status || pd.data?.task_status || "").toLowerCase();
        lastStatus = st;
        log("轮询 " + n + "：status=" + st + (pd.progress != null ? " " + pd.progress + "%" : ""));
        if (st === "succeeded" || st === "completed" || st === "succeed") { resultUrl = extractUrl(pd) || pd.data?.task_result?.videos?.[0]?.url; break; }
        if (st === "failed" || st === "cancelled" || st === "failed") {
          log("生成失败：" + JSON.stringify(pd.error || pd.data?.task_status_msg || pd).slice(0, 300), "err");
          break;
        }
      }
      if (resultUrl) {
        log("完成：" + resultUrl, "ok");
        attempts.push({ model: adapter.id, ok: true, url: resultUrl });
        break;   // 成功即停止降级
      }
      log("该模型未产出结果（最后状态=" + lastStatus + "），降级下一个", "warn");
      attempts.push({ model: adapter.id, ok: false, reason: "timeout/status=" + lastStatus });
    } catch (e) {
      log("异常：" + e.message + "，降级下一个", "err");
      attempts.push({ model: adapter.id, ok: false, reason: e.message });
    }
  }

  // ---------- 5. 汇总 ----------
  log("");
  log("=== 结果汇总 ===");
  for (const t of attempts) {
    log(`${t.ok ? "✓" : "✗"} ${t.model}${t.reason ? " — " + t.reason : ""}${t.url ? " → " + t.url : ""}`);
  }
  const winner = attempts.find((t) => t.ok && t.url);
  if (winner) log("\n最终模型：" + winner.model + "\n成片：" + winner.url, "ok");
  else if (DRY) log("\ndry-run 结束，未提交、未扣费", "ok");
  else log("\n所有模型均未产出结果", "err");

  return flush(winner || DRY || MOCK ? 0 : 1);
}

function flush(code = 0) {
  writeFileSync(OUT, L.join("\n") + "\n", "utf-8");
  process.exitCode = code;
}

main().catch((e) => { log("FATAL: " + e.message, "err"); flush(1); });
