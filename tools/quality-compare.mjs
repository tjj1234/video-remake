#!/usr/bin/env node
// 出片质量对比工具 —— 生成自包含的 HTML 对比报告
//
// 用法：
//   node tools/quality-compare.mjs --orig fixtures/sample.mp4 --out <成片URL或本地路径> \
//        --ffmpeg-dir <含 ffmpeg.exe/ffprobe.exe 的目录> [--report compare/quality-report.html]
//
// 说明：
//   - 报告包含：技术规格对比（时长/分辨率/帧率/编码/码率/体积）、SSIM、PSNR、3 组逐帧并排截图
//   - SSIM/PSNR 衡量像素级结构相似度。本产品强制换角 + 原片可能只是测试图案，
//     因此「低相似度」是设计目标而非缺陷；这两个值主要用于确认成片「有效、完整、未损坏」
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, statSync, existsSync, createWriteStream } from "node:fs";
import { dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";

// ---------- 参数 ----------
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const v = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "true";
    args.set(k, v);
  }
}
const ORIG = args.get("orig");
const OUT = args.get("out");
const FF_DIR = args.get("ffmpeg-dir") || "";
const REPORT = args.get("report") || "compare/quality-report.html";
if (!ORIG || !OUT) {
  console.error("用法: node tools/quality-compare.mjs --orig <原片> --out <成片URL或路径> [--ffmpeg-dir <目录>] [--report <路径>]");
  process.exit(2);
}
const FF = FF_DIR ? join(FF_DIR, "ffmpeg.exe") : "ffmpeg";
const FFP = FF_DIR ? join(FF_DIR, "ffprobe.exe") : "ffprobe";
const hasFF = FF_DIR ? existsSync(FF) && existsSync(FFP) : true;
if (!hasFF) {
  console.error("未找到 ffmpeg/ffprobe，请用 --ffmpeg-dir 指定目录");
  process.exit(2);
}

const WORK = join(tmpdir(), "vr-compare-" + Date.now());
mkdirSync(WORK, { recursive: true });
const FRAME_DIR = join(WORK, "frames");
mkdirSync(FRAME_DIR, { recursive: true });

function probe(p) {
  const raw = execFileSync(FFP, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", p], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
  const j = JSON.parse(raw);
  const v = j.streams.find((s) => s.codec_type === "video");
  const [a, b] = String(v.r_frame_rate || "0/1").split("/").map(Number);
  return {
    duration: parseFloat(j.format.duration),
    width: parseInt(v.width), height: parseInt(v.height),
    fps: b ? Math.round((a / b) * 100) / 100 : 0,
    codec: v.codec_name, pixfmt: v.pix_fmt,
    bitrate: parseInt(j.format.bit_rate || v.bit_rate || 0) / 1000,
    sizeKB: Math.round(statSync(p).size / 1024),
  };
}
function metric(outFile, origFile, filter) {
  const r = spawnSync(FF, ["-i", outFile, "-i", origFile, "-lavfi", filter, "-f", "null", "-"], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
  return (r.stdout || "") + (r.stderr || "");
}

async function main() {
  let outFile = OUT;
  let outUrlLabel = OUT;
  if (/^https?:\/\//i.test(OUT)) {
    outFile = join(WORK, "output.mp4");
    const res = await fetch(OUT);
    if (!res.ok) throw new Error("下载成片失败 HTTP " + res.status);
    writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
  }

  const o = probe(ORIG);
  const w = probe(outFile);
  const ssim = (metric(outFile, ORIG, "ssim").match(/All:([0-9.]+)/) || [])[1] || "n/a";
  const psnr = (metric(outFile, ORIG, "psnr").match(/average:([0-9.]+)/) || [])[1] || "n/a";

  const ts = [0.5, 2.5, Math.max(0.5, Math.min(4.0, w.duration - 1))];
  const frames = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    const oImg = join(FRAME_DIR, `orig_${i}.png`);
    const wImg = join(FRAME_DIR, `out_${i}.png`);
    execFileSync(FF, ["-y", "-ss", String(t), "-i", ORIG, "-frames:v", "1", "-update", "1", "-vf", "scale=480:-1", "-q:v", "3", oImg], { stderr: "pipe" });
    execFileSync(FF, ["-y", "-ss", String(t), "-i", outFile, "-frames:v", "1", "-update", "1", "-vf", "scale=480:-1", "-q:v", "3", wImg], { stderr: "pipe" });
    frames.push({ t, orig: "data:image/png;base64," + readFileSync(oImg).toString("base64"), out: "data:image/png;base64," + readFileSync(wImg).toString("base64") });
  }

  const specRows = [
    ["时长", o.duration + "s", w.duration + "s", o.duration.toFixed(1) === w.duration.toFixed(1) ? "✅" : "⚠️"],
    ["分辨率", o.width + "x" + o.height, w.width + "x" + w.height, (o.width === w.width && o.height === w.height) ? "✅" : "⚠️"],
    ["帧率", o.fps, w.fps, "—"],
    ["编码", o.codec, w.codec, "—"],
    ["码率(kbps)", Math.round(o.bitrate), Math.round(w.bitrate), "—"],
    ["体积", o.sizeKB + " KB", w.sizeKB + " KB", "—"],
  ];
  const specHtml = specRows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join("");
  const frameHtml = frames.map((f) => `
    <div class="pair">
      <div class="cap">t=${f.t.toFixed(1)}s · 原片</div><img src="${f.orig}" />
      <div class="cap">t=${f.t.toFixed(1)}s · 成片</div><img src="${f.out}" />
    </div>`).join("");

  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>出片质量对比 · Video Remake</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f1220;color:#e6e8f0;padding:28px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 10px;color:#9fb0ff}
.wrap{max-width:1040px;margin:0 auto}
.card{background:#171b2e;border:1px solid #262c44;border-radius:12px;padding:16px 18px;margin:12px 0}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{border:1px solid #2a3050;padding:8px 10px;text-align:left}th{background:#1d2238}
.kpi{display:flex;gap:14px;flex-wrap:wrap}
.kpi div{background:#1d2238;border-radius:10px;padding:12px 16px;flex:1;min-width:150px}
.kpi b{font-size:22px;display:block;color:#9fb0ff}
.note{font-size:13px;color:#aab;line-height:1.65}
.pair{display:flex;flex-direction:column;gap:4px;margin:10px 0;background:#13172a;border:1px solid #262c44;border-radius:10px;padding:10px}
.pair img{width:480px;max-width:100%;border-radius:6px;display:block}
.cap{font-size:12px;color:#8b95c9}a{color:#9fb0ff}
</style></head><body><div class="wrap">
<h1>出片质量对比报告</h1>
<div class="note">原片：<code>${basename(ORIG)}</code> · 成片：<code>${outUrlLabel}</code></div>
<div class="kpi">
  <div><b>${ssim}</b>SSIM（结构相似度）</div>
  <div><b>${psnr} dB</b>PSNR</div>
  <div><b>${w.width}x${w.height}</b>成片分辨率</div>
  <div><b>${w.duration}s</b>成片时长</div>
</div>
<div class="card"><h2>1. 技术规格对比</h2>
<table><tr><th>指标</th><th>原片</th><th>成片</th><th>匹配</th></tr>${specHtml}</table></div>
<div class="card"><h2>2. 相似度指标怎么读</h2><div class="note">
SSIM / PSNR 衡量<b>像素级结构相似度</b>。本产品硬规则是「<b>强制换角</b>」——成片人物/场景必须是全新内容；
若原片本身是测试图案（合成彩条），则像素相似度天然很低。<b>低相似度是设计目标，不是缺陷</b>。
这两个值的实际作用：确认成片是<b>有效、完整、未损坏</b>的视频（生成失败/花屏时指标会异常或无法计算）。
</div></div>
<div class="card"><h2>3. 逐帧视觉对比</h2>${frameHtml}</div>
</div></body></html>`;

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, html, "utf-8");
  console.log("报告已生成：" + REPORT);
  console.log(`SSIM=${ssim} PSNR=${psnr}`);
  console.log("原片=" + JSON.stringify(o));
  console.log("成片=" + JSON.stringify(w));
}

main().catch((e) => { console.error("FATAL: " + e.message); process.exit(1); });
