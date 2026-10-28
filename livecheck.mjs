// 带 Key 的真实验证：校验 Key → 列出可用参考视频模型 → 可选真跑
// 用法：
//   node livecheck.mjs --key sk-pt-xxx
//   node livecheck.mjs --key sk-pt-xxx --url <源视频> --direction "..." [--model kling-v2-1-master]
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PT_BASE = "https://api.powertokens.ai";
const DIR = "C:\\Users\\admin\\WorkBuddy\\2026-10-27-17-26-05\\video-remake-prototype";
const LOG = DIR + "\\.livecheck.txt";
const L = [];
const log = (s) => L.push(s);

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const v = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "true";
    args.set(k, v);
  }
}
const key = args.get("key") || process.env.POWERTOKENS_API_KEY || "";
const srcUrl = args.get("url") || "";
const direction = args.get("direction") || "";
const wantModel = args.get("model") || "";

const maskKey = (k) => (k ? k.slice(0, 8) + "***" + k.slice(-4) : "(empty)");

const KNOWN_REF = {
  "kling-v2-1-master": true, "kling-video-o1": true, "kling-v3": true, "wan2.7-r2v": true,
  "wan3.0-video": false, "seedance-1-5-pro-251215": false,
};
function isVideo(id) {
  const m = id.toLowerCase();
  if (m.includes("image") || m.includes("seedream") || m.includes("qwen-image")) return false;
  if (m.includes("tts") || m.includes("asr") || m.includes("embed") || m.includes("rerank")) return false;
  return true;
}
function supportsRef(id) {
  const m = id.toLowerCase();
  if (m in KNOWN_REF) return KNOWN_REF[m];
  if (m.includes("seedance")) return false;
  if (m.startsWith("wan3")) return false;
  if (m.startsWith("kling") || m.startsWith("wan2") || m.includes("hailuo") || m.startsWith("vidu")) return true;
  return false;
}

async function main() {
  log("=== PT Live Check ===");
  log("Key: " + maskKey(key));
  if (!key) { log("ERROR: 未提供 key"); return finish(1); }

  // 1. 校验 key（/v1/models 免费）
  let ids = [];
  const r = await fetch(PT_BASE + "/v1/models", { headers: { Authorization: "Bearer " + key } });
  const txt = await r.text();
  log("GET /v1/models → HTTP " + r.status);
  if (!r.ok) { log("Key 无效或被拒：" + txt.slice(0, 300)); return finish(1); }
  try {
    const j = JSON.parse(txt);
    const arr = j.data || j.models || [];
    ids = arr.map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean);
  } catch (e) { log("模型列表解析失败：" + e.message); return finish(1); }

  const vids = ids.filter(isVideo);
  const usable = vids.filter(supportsRef);
  log("模型总数：" + ids.length + "  视频模型：" + vids.length + "  支持参考视频：" + usable.length);
  log("");
  log("【可用于重制的模型】");
  for (const id of usable) log("  ✓ " + id);
  log("");
  log("【视频模型但不可用于参考视频】");
  for (const id of vids.filter((x) => !supportsRef(x))) log("  ✗ " + id);
  log("");
  log("【非视频模型（前 20 个）】");
  const others = ids.filter((x) => !isVideo(x));
  for (const id of others.slice(0, 20)) log("  · " + id);
  if (others.length > 20) log("  … 共 " + others.length + " 个");

  if (!srcUrl) { log(""); log("（未提供 --url，仅做 Key 校验，不发起生成）"); return finish(usable.length ? 0 : 1); }

  // 2. 真跑：调用 engine.mjs
  const model = wantModel || usable[0];
  if (!model) { log("无可用于参考视频的模型"); return finish(1); }
  log("");
  log("=== 发起真实重制 ===");
  log("模型：" + model);
  log("源视频：" + srcUrl);
  log("（真实生成约 3 分钟，请耐心等待）");
  try {
    execFileSync(process.execPath, [DIR + "\\engine.mjs", "--url", srcUrl, "--key", key, "--model", model, "--direction", direction], { encoding: "utf-8", timeout: 900000 });
  } catch (e) { log("engine 非零退出：" + e.message); }
  log("详见 .engine_out.txt");
  finish(0);
}
function finish(code) {
  writeFileSync(LOG, L.join("\n") + "\n", "utf-8");
  process.exitCode = code;
}
main().catch((e) => { log("FATAL: " + e.message); finish(1); });
