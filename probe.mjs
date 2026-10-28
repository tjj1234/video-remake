// 源视频探测：用 ffprobe 读取真实时长 / 宽高 / 帧率 / 是否有音轨
// 目的：让「重制」尽量匹配原片的时长与尺寸（用户要求）
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

const FF_CANDIDATES = [
  "ffprobe",
  // winget 正常安装后的 shim
  "C:\\Users\\admin\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffprobe.exe",
  // 本机便携版（winget 装不上、手工解压到项目旁时用这个）
  "C:\\Users\\admin\\WorkBuddy\\2026-10-27-17-26-05\\pts\\ffmpeg\\ffmpeg-9.0.2-full_build\\bin\\ffprobe.exe",
  "C:\\ProgramData\\chocolatey\\bin\\ffprobe.exe",
  "C:\\ffmpeg\\bin\\ffprobe.exe",
];

export function findFfprobe() {
  for (const c of FF_CANDIDATES) {
    try {
      execFileSync(c, ["-version"], { stdio: "ignore", timeout: 8000 });
      return c;
    } catch {}
  }
  return null;
}

export function findFfmpeg() {
  const probe = findFfprobe();
  if (!probe) return null;
  // ffmpeg 与 ffprobe 同目录
  const guess = probe.replace(/ffprobe(\.exe)?$/i, (m, ext) => "ffmpeg" + (ext || ""));
  try {
    execFileSync(guess, ["-version"], { stdio: "ignore", timeout: 8000 });
    return guess;
  } catch {}
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 8000 });
    return "ffmpeg";
  } catch {}
  return null;
}

// 探测远程/本地视频；src 可为 URL 或本地路径
export function probeVideo(src) {
  const probe = findFfprobe();
  if (!probe) throw new Error("未找到 ffprobe，无法读取源视频时长/尺寸（请先安装 ffmpeg）");
  let raw;
  try {
    raw = execFileSync(
      probe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", src],
      { encoding: "utf-8", timeout: 90000, maxBuffer: 8 * 1024 * 1024 }
    );
  } catch (e) {
    throw new Error("ffprobe 读取失败：" + (e.stderr?.toString?.().slice(0, 300) || e.message));
  }
  const j = JSON.parse(raw);
  const v = (j.streams || []).find((s) => s.codec_type === "video");
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  if (!v) throw new Error("源文件里没有视频流");
  const dur = Number(j.format?.duration || v.duration || 0);
  const fps = (() => {
    const r = String(v.avg_frame_rate || v.r_frame_rate || "0/1");
    const [n, d] = r.split("/").map(Number);
    return d ? +(n / d).toFixed(3) : 0;
  })();
  return {
    duration: Number.isFinite(dur) ? +dur.toFixed(2) : 0,
    width: v.width || 0,
    height: v.height || 0,
    fps,
    hasAudio: !!a,
    codec: v.codec_name || "",
    shortSide: Math.min(v.width || 0, v.height || 0),
    bitrate: Number(j.format?.bit_rate || 0),
  };
}

// 从源视频抽一帧做参考图（Kling 运镜 / MiniMax 必需 image）
export function extractFrame(src, outPath, atSec = 0.5) {
  const ff = findFfmpeg();
  if (!ff) throw new Error("未找到 ffmpeg，无法抽帧");
  try {
    execFileSync(ff, ["-y", "-ss", String(atSec), "-i", src, "-frames:v", "1", "-q:v", "2", outPath],
      { stdio: "ignore", timeout: 90000 });
  } catch (e) {
    throw new Error("抽帧失败：" + e.message);
  }
  if (!existsSync(outPath) || statSync(outPath).size < 1024) throw new Error("抽帧结果为空：" + outPath);
  return outPath;
}

// 由源视频尺寸推断最接近的宽高比枚举
// ⚠️ wan2.7-r2v 官方只接受 16:9 / 9:16 / 1:1 / 4:3 / 3:4，
//    传 adaptive 会被 400 拒绝（实测：only supports ratio 16:9, 9:16, 1:1, 4:3, or 3:4）。
//    所以这里永远返回表内最接近的比例，不回退 adaptive。
export function guessRatio(width, height) {
  const table = [["16:9", 16 / 9], ["4:3", 4 / 3], ["1:1", 1], ["3:4", 3 / 4], ["9:16", 9 / 16]];
  if (!width || !height) return "16:9";   // 无信息时取最常见的横屏比例
  const r = width / height;
  let best = table[0], bestDiff = Infinity;
  for (const t of table) {
    const d = Math.abs(r - t[1]);
    if (d < bestDiff) { bestDiff = d; best = t; }
  }
  return best[0];
}

// 竖屏 / 横屏 / 方形
export function orientation(width, height) {
  if (!width || !height) return "unknown";
  const r = width / height;
  if (r > 1.15) return "landscape";
  if (r < 0.87) return "portrait";
  return "square";
}
