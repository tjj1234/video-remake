// 适配器自测：验证「不同模型参数符合各自要求」
import { MODEL_CHAIN, getAdapter } from "./adapters.mjs";
import { guessRatio, orientation } from "./probe.mjs";
import { writeFileSync } from "node:fs";

const DIR = "C:\\Users\\admin\\WorkBuddy\\2026-10-27-17-26-05\\video-remake-prototype";
const out = [];
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; out.push("PASS  " + n); } else { fail++; out.push("FAIL  " + n + (d ? " :: " + d : "")); } };

// 构造假源视频元数据
const srcLandscape = { duration: 5, width: 1920, height: 1080, shortSide: 1080, fps: 30, hasAudio: true };
const srcPortrait  = { duration: 8, width: 1080, height: 1920, shortSide: 1080, fps: 30, hasAudio: true };
const srcLow       = { duration: 6, width: 640, height: 360, shortSide: 360, fps: 30, hasAudio: true };

const opts = (extra = {}) => ({ sourceUrl: "https://x/a.mp4", sound: true, imageUrl: "https://x/f.jpg", ...extra });

// ---------- Wan 2.7 r2v ----------
const wan = getAdapter("wan2.7-r2v");
let b = wan.fit(srcLandscape, "P", opts());
check("Wan 端点 /v1/videos", b.path === "/v1/videos");
check("Wan 用 media.reference_video", b.body.media?.[0]?.type === "reference_video");
check("Wan 1080p源 → size 1080P", b.body.size === "1080P", b.body.size);
check("Wan seconds 为字符串", typeof b.body.seconds === "string");
check("Wan 横屏 → ratio 16:9", b.body.ratio === "16:9", b.body.ratio);
check("Wan 无 image 字段", !("image" in b.body));

const b2 = getAdapter("wan2.7-r2v").fit(srcPortrait, "P", opts());
check("Wan 竖屏 → ratio 9:16", b2.body.ratio === "9:16", b2.body.ratio);

const b3 = getAdapter("wan2.7-r2v").fit(srcLow, "P", opts());
check("Wan 360p源 → size 480P", b3.body.size === "480P", b3.body.size);

// 时长受「输入+输出 ≤30」约束
const longSrc = { duration: 28, width: 1920, height: 1080, shortSide: 1080, fps: 30, hasAudio: true };
const b4 = getAdapter("wan2.7-r2v").fit(longSrc, "P", opts());
check("Wan 长源视频时长被压缩", Number(b4.body.seconds) <= 2, b4.body.seconds);

// ---------- MiniMax ----------
const mm = getAdapter("MiniMax-Hailuo-2.3");
const bm = mm.fit(srcLandscape, "P", opts());
check("MiniMax 端点 /v1/videos", bm.path === "/v1/videos");
check("MiniMax 有 image 字段", typeof bm.body.image === "string" && bm.body.image.length > 0);
check("MiniMax 无 media 字段", !("media" in bm.body));
check("MiniMax seconds 只能是 6 或 10", ["6", "10"].includes(bm.body.seconds), bm.body.seconds);
check("MiniMax size 只能是 768P/1080P", ["768P", "1080P"].includes(bm.body.size), bm.body.size);
check("MiniMax 5s源 → 6s", bm.body.seconds === "6", bm.body.seconds);

const bm2 = getAdapter("MiniMax-Hailuo-2.3").fit(srcPortrait, "P", opts());  // 8s
check("MiniMax 8s源 → 6s", bm2.body.seconds === "6", bm2.body.seconds);

const src12 = { duration: 12, width: 1920, height: 1080, shortSide: 1080, fps: 30, hasAudio: true };
const bm3 = getAdapter("MiniMax-Hailuo-2.3").fit(src12, "P", opts());
check("MiniMax 12s源 → 10s", bm3.body.seconds === "10", bm3.body.seconds);
check("MiniMax 10s时强制 768P（1080P不可用）", bm3.body.size === "768P", bm3.body.size);

// ---------- Kling v3 运镜 ----------
const kl = getAdapter("kling-v3");
const bk = kl.fit(srcLandscape, "P", opts());
check("Kling 走原生运镜端点", bk.path === "/kling/v1/videos/motion-control", bk.path);
check("Kling 用 model_name 而非 model", "model_name" in bk.body && !("model" in bk.body));
check("Kling 有 video_url", typeof bk.body.video_url === "string");
check("Kling 有 image_url（必填）", typeof bk.body.image_url === "string");
check("Kling 有 character_orientation", ["image", "video"].includes(bk.body.character_orientation));
check("Kling 横屏 → orientation=video（允许30s）", bk.body.character_orientation === "video");
check("Kling 无 size 字段（用 mode）", !("size" in bk.body));
check("Kling 无 seconds 字段", !("seconds" in bk.body));
check("Kling mode 是 std/pro", ["std", "pro"].includes(bk.body.mode));
check("Kling 1080p源 → mode=pro", bk.body.mode === "pro", bk.body.mode);
check("Kling keep_original_sound 是 yes/no", ["yes", "no"].includes(bk.body.keep_original_sound));

const bk2 = getAdapter("kling-v3").fit(srcPortrait, "P", opts());
check("Kling 竖屏 → orientation=image", bk2.body.character_orientation === "image");

// 竖屏 >10s 应该报错（image 朝向限制 10s）
const srcPortrait12 = { duration: 12, width: 1080, height: 1920, shortSide: 1080, fps: 30, hasAudio: true };
let threw = false, msg = "";
try { getAdapter("kling-v3").fit(srcPortrait12, "P", opts()); } catch (e) { threw = true; msg = e.message; }
// 拆成不含空格的片段匹配，规避编辑链路可能引入的全角/异体空格
check("Kling 竖屏12s → 报错并说明原因", threw && msg.includes("character_orientation") && msg.includes("10s") && msg.includes("不支持") === false, msg);

const bkSound = getAdapter("kling-v3").fit(srcLandscape, "P", opts({ sound: false }));
check("Kling sound=false → keep_original_sound=no", bkSound.body.keep_original_sound === "no");

// ---------- 通用 ----------
check("MODEL_CHAIN 全部为可用模型", MODEL_CHAIN.length >= 3 && MODEL_CHAIN.every((a) => a.id));
check("MODEL_CHAIN 无 Seedance", !MODEL_CHAIN.some((a) => /seedance|dreamina|seedream/i.test(a.id)));
check("MODEL_CHAIN 首选 wan2.7-r2v（无需抽帧）", MODEL_CHAIN[0].id === "wan2.7-r2v");
check("wan2.7-r2v 不需要抽帧", MODEL_CHAIN[0].needsFrameExtract === false);
check("Kling 需要抽帧", getAdapter("kling-v3").needsFrameExtract === true);
check("MiniMax 需要抽帧", getAdapter("MiniMax-Hailuo-2.3").needsFrameExtract === true);

// ratio 推断
check("guessRatio 1920x1080 → 16:9", guessRatio(1920, 1080) === "16:9");
check("guessRatio 1080x1920 → 9:16", guessRatio(1080, 1920) === "9:16");
check("guessRatio 1:1", guessRatio(1000, 1000) === "1:1");
check("orientation 横屏", orientation(1920, 1080) === "landscape");
check("orientation 竖屏", orientation(1080, 1920) === "portrait");

// 无尺寸信息时不应崩
const unknown = { duration: 5, width: 0, height: 0, shortSide: 0, fps: 0, hasAudio: true };
check("无尺寸信息时 Wan 仍可用", (() => { try { getAdapter("wan2.7-r2v").fit(unknown, "P", opts()); return true; } catch { return false; } })());

// ---------- 回归：wan2.7-r2v 拒绝 adaptive（线上实测 400）----------
// 报错原文：wan2.7-r2v only supports ratio 16:9, 9:16, 1:1, 4:3, or 3:4
const WAN_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];
const weird = [
  [0, 0], [1920, 1080], [1080, 1920], [1000, 1000],
  [2000, 1000],   // 2:1 极端宽屏，旧逻辑会回退 adaptive
  [1000, 2000],   // 1:2 极端竖屏
  [1440, 1080], [1024, 768], [800, 600],
];
{
  let allLegal = true, bad = "";
  for (const [w, h] of weird) {
    const r = getAdapter("wan2.7-r2v").fit(
      { duration: 5, width: w, height: h, shortSide: Math.min(w, h) || 720 }, "P", opts()
    ).body.ratio;
    if (!WAN_RATIOS.includes(r)) { allLegal = false; bad += `${w}x${h}→${r} `; }
  }
  check("Wan ratio 永远在合法枚举内（绝不 adaptive）", allLegal, bad);
}
check("guessRatio 极端宽屏 2:1 不回退 adaptive", guessRatio(2000, 1000) !== "adaptive");
check("guessRatio 极端竖屏 1:2 不回退 adaptive", guessRatio(1000, 2000) !== "adaptive");
check("guessRatio 无尺寸时给出合法值", WAN_RATIOS.includes(guessRatio(0, 0)));

// ---------- 回归：缺图时应明确报错而非静默跳过 ----------
{
  let e1 = null, e2 = null;
  try { getAdapter("MiniMax-Hailuo-2.3").fit(srcLandscape, "P", opts({ imageUrl: null })); } catch (e) { e1 = e; }
  try { getAdapter("kling-v3").fit(srcLandscape, "P", opts({ imageUrl: null })); } catch (e) { e2 = e; }
  check("MiniMax 缺图 → 明确报错", !!e1 && e1.message.includes("image"));
  check("Kling 缺图 → 明确报错", !!e2 && e2.message.includes("image_url"));
}

writeFileSync(DIR + "\\.adaptertest.txt", out.join("\n") + `\n\n通过 ${pass} / 共 ${pass + fail}`, "utf-8");
process.exitCode = fail ? 1 : 0;
