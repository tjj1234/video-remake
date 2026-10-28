#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
video-remake-prototype / remake.py  (完整版 remake 引擎)
=========================================================
自研替代 Media.io Viral Studio 的「给视频 → Remake」内核（非克隆、不侵权）。

三大能力（对应上次逆向还原的链路）：
  ① 分镜序列：LLM 把源视频拆成 shots[]，逐段生成后用 ffmpeg 拼成完整视频
  ② 视觉风格提取：用多模态模型(可选)读关键帧，抽出 色调/构图/运镜/光感，喂给生成
  ③ 动作迁移：把源视频(或某段)作 --ref-video，用 Kling 系列模型继承动作/节奏

流程：
  ingest   → 抽关键帧 + 转写(可选) + 按分镜切源片段
  analyze  → (② 视觉提取) + LLM 出 storyboard(shots[]，每段含 prompt/时长/参考)
  generate → 逐段调 pt_video.py（图生视频 / 动作迁移）
  stitch   → ffmpeg concat 拼成成片

⚠️ 法律边界：只分析你自己拍摄 / 已获授权的视频。
   不要拿他人受版权保护的视频 remake 后对外分发。
   new_script 要求 LLM 产出「同风格、不同内容」的原创脚本。
"""

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request

# 强制 stdout/stderr 为 UTF-8，避免旧 GBK 控制台下中文乱码
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# ----------------------------- 配置（可用环境变量覆盖） -----------------------------
PT_BASE = "https://api.powertokens.ai"
CHAT_URL = f"{PT_BASE}/v1/chat/completions"

# 文本分析（出 storyboard）模型
ANALYZE_MODEL = os.environ.get("REMAKE_ANALYZE_MODEL", "deepseek-v4-pro")
# ② 视觉风格提取模型（需为多模态模型；若不支持图片会自动降级为纯文本）
VISION_MODEL = os.environ.get("REMAKE_VISION_MODEL", "deepseek-v4-pro")

PT_VIDEO_SCRIPT = os.environ.get(
    "PT_VIDEO_SCRIPT",
    r"C:\Users\admin\.workbuddy\skills\powertokens-video\scripts\pt_video.py",
)
# ① 普通分镜生成模型（图生视频，默认最便宜最稳）
GEN_MODEL = os.environ.get("REMAKE_GEN_MODEL", "wan3.0-video")
# ③ 动作迁移模型（需支持 --ref-video）
# 注意：不要用 Seedance 系列 —— 需先签《Asset Library User Agreement》且素材只收 asset://，
# 外部 http(s) 会被前置拒绝，与本脚本「直接吃源视频 URL」的模式不兼容。
MOTION_MODEL = os.environ.get("REMAKE_MOTION_MODEL", "kling-v2-1-master")
GEN_DURATION = int(os.environ.get("REMAKE_GEN_DURATION", "5"))
RESOLUTION = os.environ.get("REMAKE_RESOLUTION", "720p")
DURATION_GUESS = float(os.environ.get("REMAKE_DURATION_GUESS", "30"))  # 无 ffprobe 时的时长假设


def log(msg: str) -> None:
    print(f"[remake] {msg}", flush=True)


def need(tool: str) -> None:
    if shutil.which(tool) is None:
        log(f"缺少依赖: {tool}（请先安装并加入 PATH）")
        sys.exit(1)


def get_key() -> str:
    key = os.environ.get("POWERTOKENS_API_KEY", "")
    if not key:
        log("未检测到 POWERTOKENS_API_KEY。请在环境变量中设置你的 PT Key，"
            "或运行：python scripts/pt_video.py config --set-key \"sk-pt-xxxx\"")
        sys.exit(2)
    return key


def run(cmd, check=True, capture=False):
    """统一执行子进程；dry-run 不应走到这里（调用方负责）。"""
    log("  $ " + " ".join(str(c) for c in cmd))
    if capture:
        return subprocess.run(cmd, check=check, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE)
    return subprocess.run(cmd, check=check)


# ----------------------------- 1. ingest：抽帧 + 转写 + 切源片段 -----------------------------
def probe_duration(src: str) -> float:
    """用 ffprobe 取时长；失败返回 DURATION_GUESS。"""
    ff = shutil.which("ffprobe")
    if not ff:
        return DURATION_GUESS
    try:
        out = subprocess.run(
            [ff, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", src],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        ).stdout.decode("utf-8", "ignore").strip()
        return float(out) if out else DURATION_GUESS
    except Exception:
        return DURATION_GUESS


def ingest(src: str, workdir: str, shots: int, dry_run: bool):
    """返回 (frames, transcript, src_segments)。

    frames: 每分镜一张代表帧路径（list）
    src_segments: 每分镜对应的源视频切片路径（动作迁移用；dry-run 下为占位路径）
    """
    frames, src_segments = [], []
    duration = probe_duration(src) if not dry_run else DURATION_GUESS
    per = duration / max(shots, 1)

    if dry_run:
        # 不依赖 ffmpeg：用占位路径，便于离线 dry-run 验证流程
        for i in range(shots):
            frames.append(os.path.join(workdir, f"shot_{i+1}_frame.jpg"))
            src_segments.append(os.path.join(workdir, f"src_seg_{i+1}.mp4"))
        return frames, "", src_segments

    need("ffmpeg")
    # 均匀抽代表帧
    for i in range(shots):
        t = (i + 0.5) * per
        ts = f"{int(t//3600):02d}:{int(t%3600//60):02d}:{t%60:05.2f}"
        p = os.path.join(workdir, f"shot_{i+1}_frame.jpg")
        subprocess.run(
            ["ffmpeg", "-y", "-ss", ts, "-i", src, "-frames:v", "1", "-q:v", "2", p],
            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if os.path.exists(p):
            frames.append(p)

    # 切源片段（动作迁移用）
    for i in range(shots):
        ss = i * per
        seg = os.path.join(workdir, f"src_seg_{i+1}.mp4")
        subprocess.run(
            ["ffmpeg", "-y", "-ss", f"{ss:.2f}", "-i", src, "-t", f"{per:.2f}",
             "-c", "copy", seg],
            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if os.path.exists(seg):
            src_segments.append(seg)

    # 转写（可选）
    transcript = ""
    audio = os.path.join(workdir, "audio.wav")
    rc = subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", audio],
        check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ).returncode
    if rc == 0:
        whisper = shutil.which("whisper") or shutil.which("whisper-cli")
        if whisper:
            subprocess.run(
                [whisper, audio, "--model", "base", "--output_format", "txt"],
                check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            txt = audio.replace(".wav", ".txt")
            if os.path.exists(txt):
                transcript = open(txt, encoding="utf-8", errors="ignore").read().strip()
        else:
            log("（未安装 whisper，跳过自动转写；可用 --transcript 手动提供字幕）")
    return frames, transcript, src_segments


# ----------------------------- ② 视觉风格提取（多模态，可降级） -----------------------------
VISION_SYSTEM = (
    "你是专业影像美术指导。用户给你几张视频关键帧（按时间顺序）。"
    "请只输出 JSON，描述可被执行复刻的视觉特征：\n"
    "{\n"
    '  "palette": "主色调与配色（如 高对比冷调蓝橙）",\n'
    '  "composition": "构图规律（如 三分法/居中特写/广角）",\n'
    '  "camera_movement": "运镜（如 缓慢推进/手持晃动/固定）",\n'
    '  "lighting": "光感（如 自然光/硬光/柔光/夜景霓虹）",\n'
    '  "mood": "整体氛围（如 活力/高级感/生活化）",\n'
    '  "visual_prompt": "英文视觉提示词，概括上面所有特征，供视频模型使用"\n'
    "}"
)


def img_to_dataurl(path: str) -> str:
    with open(path, "rb") as f:
        b = base64.b64encode(f.read()).decode("ascii")
    return f"data:image/jpeg;base64,{b}"


def analyze_vision(frames, dry_run: bool):
    """返回视觉 brief(dict) 或 None。dry-run 仅打印报文结构。"""
    if not frames:
        return None
    content = [{"type": "text",
                "text": "以下是视频的关键帧，请分析其视觉风格并输出 JSON。"}]
    if dry_run:
        log(f"[dry-run] 视觉提取将向 {VISION_MODEL} 发送 {len(frames)} 张关键帧(image_url)+ 视觉 prompt")
        return None
    for fp in frames:
        if os.path.exists(fp):
            content.append({"type": "image_url",
                            "image_url": {"url": img_to_dataurl(fp)}})
    payload = {
        "model": VISION_MODEL,
        "messages": [
            {"role": "system", "content": VISION_SYSTEM},
            {"role": "user", "content": content},
        ],
        "temperature": 0.4,
    }
    key = get_key()
    try:
        req = urllib.request.Request(
            CHAT_URL, data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": f"Bearer {key}",
                     "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        text = data["choices"][0]["message"]["content"]
        s, e = text.find("{"), text.rfind("}")
        return json.loads(text[s:e + 1]) if s != -1 and e != -1 else None
    except Exception as ex:  # 模型不支持图片等 -> 降级为纯文本
        log(f"⚠️ 视觉模型调用失败（{ex}），降级为纯文本风格提取。")
        return None


# ----------------------------- 出 storyboard（文本 LLM） -----------------------------
STORYBOARD_SYSTEM = (
    "你是一位短视频导演 + 创意分析师。给定一段视频的字幕、可选备注，"
    "以及（可选）视觉风格分析，你要产出一份「逐镜头 remake 分镜表」。\n"
    "要求：\n"
    "1) 把整条视频拆成若干镜头(shots)，每个镜头都能独立用 AI 视频模型生成；\n"
    "2) 每个镜头的 prompt_for_generation 用英语、可执行、含视觉风格；\n"
    "3) 整体 new_script 是「同风格、不同内容」的原创脚本，避免照搬原词；\n"
    "4) 标注哪些镜头适合做动作迁移(use_ref_video=true，需继承源视频动作)。\n"
    "只输出一个 JSON 对象：\n"
    "{\n"
    '  "overall_style": "整体风格一句话",\n'
    '  "new_script": "原创新脚本全文",\n'
    '  "shots": [\n'
    '    {"index":1, "duration":5, "prompt_for_generation":"英",\n'
    '     "negative_prompt":"", "use_ref_video":false},\n'
    '    ...\n'
    "  ]\n"
    "}"
)


def build_storyboard_prompt(transcript: str, notes: str, vision_brief: dict, shots: int) -> str:
    parts = [f"请产出约 {shots} 个镜头的分镜表。"]
    if vision_brief:
        parts.append("【视觉风格分析(来自多模态模型)】\n" +
                     json.dumps(vision_brief, ensure_ascii=False, indent=2))
    else:
        parts.append("【视觉风格】未提供（请基于常识推断）。")
    if transcript:
        parts.append(f"【字幕 transcript】\n{transcript}")
    else:
        parts.append("【字幕】无")
    if notes:
        parts.append(f"【补充备注 notes】\n{notes}")
    parts.append("输出 JSON（见系统提示字段）。")
    return "\n\n".join(parts)


def call_chat(key: str, model: str, system: str, user: str) -> dict:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.7,
    }
    req = urllib.request.Request(
        CHAT_URL, data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    content = data["choices"][0]["message"]["content"]
    s, e = content.find("{"), content.rfind("}")
    if s == -1 or e == -1:
        raise ValueError(f"模型未返回合法 JSON：{content[:200]}")
    return json.loads(content[s:e + 1])


def analyze_storyboard(transcript, notes, vision_brief, shots, dry_run):
    user = build_storyboard_prompt(transcript, notes, vision_brief, shots)
    if dry_run:
        log("[dry-run] 将发送 storyboard 分析 prompt（系统+用户，附视觉 brief 与否取决于 ②）：")
        print("---SYSTEM---\n" + STORYBOARD_SYSTEM)
        print("---USER---\n" + user)
        # 给一个示例结构，便于 dry-run 看产物形态
        return {"overall_style": "(dry-run 占位)", "new_script": "(dry-run 占位)",
                "shots": [{"index": i + 1, "duration": GEN_DURATION,
                           "prompt_for_generation": "cinematic remake shot",
                           "negative_prompt": "", "use_ref_video": False}
                          for i in range(shots)]}
    key = get_key()
    log(f"调用 {ANALYZE_MODEL} 产出 storyboard ...")
    board = call_chat(key, ANALYZE_MODEL, STORYBOARD_SYSTEM, user)
    board.setdefault("shots", [])
    log(f"storyboard 完成 ✔ 共 {len(board['shots'])} 个镜头")
    return board


# ----------------------------- 3. generate：逐段生成 -----------------------------
def gen_one(shot, idx, frames, src_segments, workdir, use_motion, dry_run):
    """生成单个镜头片段，返回片段路径。"""
    prompt = shot.get("prompt_for_generation") or "cinematic remake shot"
    dur = int(shot.get("duration") or GEN_DURATION)
    neg = shot.get("negative_prompt", "") or ""
    seg_out = os.path.join(workdir, f"gen_seg_{idx}.mp4")

    # 该镜头用的代表帧（若有）
    ref_frame = frames[idx - 1] if frames and idx - 1 < len(frames) else None
    motion_this = use_motion and bool(shot.get("use_ref_video"))

    cmd = [
        sys.executable, PT_VIDEO_SCRIPT, "generate",
        "-p", prompt, "-o", seg_out, "-d", str(dur),
        "-r", RESOLUTION,
    ]
    if motion_this:
        # ③ 动作迁移：用源片段作 --ref-video（Kling 系列）
        src_seg = src_segments[idx - 1] if src_segments and idx - 1 < len(src_segments) else None
        cmd += ["-m", MOTION_MODEL]
        if src_seg and os.path.exists(src_seg):
            cmd += ["--ref-video", src_seg]
        if ref_frame and os.path.exists(ref_frame):
            cmd += ["--ref", ref_frame]
    else:
        cmd += ["-m", GEN_MODEL]
        if ref_frame and os.path.exists(ref_frame):
            cmd += ["--ref", ref_frame]
    if neg:
        cmd += ["--negative-prompt", neg]

    if dry_run:
        log(f"[dry-run] 镜头 {idx} 将执行： " + " ".join(str(c) for c in cmd))
        return seg_out
    if not os.path.exists(PT_VIDEO_SCRIPT):
        log(f"未找到 PT 生成脚本：{PT_VIDEO_SCRIPT}（用 PT_VIDEO_SCRIPT 环境变量指定）")
        sys.exit(1)
    label = "动作迁移" if motion_this else "图生视频"
    log(f"镜头 {idx}/{len(frames) if frames else '?'} [{label}] 生成中，预计 1-5 分钟 ...")
    subprocess.run(cmd, check=True)
    return seg_out


def generate_storyboard(board, frames, src_segments, workdir, use_motion, dry_run):
    segs = []
    shots = board.get("shots", [])
    for i, shot in enumerate(shots, start=1):
        segs.append(gen_one(shot, i, frames, src_segments, workdir, use_motion, dry_run))
    return segs


# ----------------------------- 4. stitch：ffmpeg 拼接 -----------------------------
def stitch(segs, out_path, dry_run):
    if dry_run:
        log("[dry-run] 将用 ffmpeg concat 拼接 " + str(len(segs)) + " 段：")
        log("  ffmpeg -f concat -safe 0 -i segments.txt -c:v libx264 -an " + out_path)
        return
    need("ffmpeg")
    lst = out_path + ".segments.txt"
    with open(lst, "w", encoding="utf-8") as f:
        for s in segs:
            if os.path.exists(s):
                f.write(f"file '{os.path.abspath(s)}'\n")
    # 重编码拼接：不同模型产出的片段 codec/分辨率可能不一致，直接 -c copy 会失败；
    # 统一重编码为 H.264 + 丢弃音频（多数生成片段为无声，避免音频流缺失导致报错）。
    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst,
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", out_path],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    log("拼接完成 ✔")


# ----------------------------- 报告 -----------------------------
def write_report(out_path, board, src, use_motion, use_vision):
    if not board:
        return
    md = ["# Remake Storyboard 报告\n",
          f"- 源视频: `{src}`",
          f"- 视觉提取(②): {'开启' if use_vision else '关闭'}",
          f"- 动作迁移(③): {'开启' if use_motion else '关闭'}",
          f"- 成品: `{out_path}`\n",
          "## 整体风格\n" + board.get("overall_style", ""),
          "## 原创新脚本\n" + board.get("new_script", ""),
          "## 分镜表"]
    for s in board.get("shots", []):
        md.append(f"### 镜头 {s.get('index')}  ({s.get('duration')}s"
                  + (" · 动作迁移" if s.get("use_ref_video") else "") + ")\n"
                  + "- prompt: `" + s.get("prompt_for_generation", "") + "`\n"
                  + "- neg: " + (s.get("negative_prompt") or ""))
    with open(os.path.join(os.path.dirname(os.path.abspath(out_path)),
                           "remake_brief.md"), "w", encoding="utf-8") as f:
        f.write("\n\n".join(md))
    log("已写出 remake_brief.md")


# ----------------------------- 入口 -----------------------------
def main() -> None:
    global GEN_MODEL, MOTION_MODEL
    ap = argparse.ArgumentParser(
        description="视频 remake 完整引擎（分镜+视觉+动作迁移，自研替代版）")
    ap.add_argument("video", help="源视频本地路径（你自己的/已授权）")
    ap.add_argument("-o", "--output", default="remake.mp4", help="成品输出路径")
    ap.add_argument("--shots", type=int, default=4, help="期望分镜数（默认 4）")
    ap.add_argument("--use-vision", action="store_true",
                    help="② 开启视觉风格提取（需多模态模型，失败自动降级）")
    ap.add_argument("--action-migration", action="store_true",
                    help="③ 开启动作迁移（用 --ref-video，需 Kling/Wan 系列；不支持 Seedance）")
    ap.add_argument("--gen-model", default=GEN_MODEL, help="① 普通分镜生成模型")
    ap.add_argument("--motion-model", default=MOTION_MODEL, help="③ 动作迁移模型")
    ap.add_argument("--transcript", help="手动提供字幕（不走 whisper 时使用）")
    ap.add_argument("--notes", help="补充备注，帮助分析")
    ap.add_argument("--url", help="可选：先下载该 URL 视频（仅限你自有/已授权链接）")
    ap.add_argument("--dry-run", action="store_true",
                    help="只打印步骤与命令，不抽帧/不调 API/不花真钱")
    args = ap.parse_args()

    GEN_MODEL = args.gen_model
    MOTION_MODEL = args.motion_model

    # Seedance 全系禁用：需先签《Asset Library User Agreement》+ 素材只收 asset://，
    # 与本脚本「直接吃源视频 URL」的模式冲突，提前拦住避免跑到一半才报错。
    _SEEDANCE_RE = re.compile(r"seedance|seedream|dreamina", re.IGNORECASE)
    for _label, _m in (("--gen-model", GEN_MODEL), ("--motion-model", MOTION_MODEL)):
        if _SEEDANCE_RE.search(_m):
            log(f"不支持 Seedance 系列模型（{_label}={_m}）")
            log("原因：需先签《Asset Library User Agreement》，且媒体只收 asset://，外部 http(s) 会被拒。")
            log("请改用：kling-v2-1-master / kling-video-o1 / kling-v3 / wan2.7-r2v")
            sys.exit(1)

    workdir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(workdir, exist_ok=True)

    src = args.video
    if args.url:
        log(f"下载视频: {args.url}")
        if args.dry_run:
            src = os.path.join(workdir, "source_downloaded.mp4")
        else:
            dl = os.path.join(workdir, "source_downloaded.mp4")
            urllib.request.urlretrieve(args.url, dl)
            src = dl

    caps = []
    caps.append("①分镜" )
    if args.use_vision: caps.append("②视觉")
    if args.action_migration: caps.append("③动作迁移")
    log("启用能力: " + " + ".join(caps) + f"  | 分镜数≈{args.shots}")

    log("步骤 1/4 ingest：抽帧 + 转写 + 切源片段")
    frames, transcript, src_segments = ingest(src, workdir, args.shots, args.dry_run)
    if args.transcript:
        transcript = args.transcript

    vision_brief = None
    if args.use_vision:
        log("步骤 2/4 ② 视觉风格提取")
        vision_brief = analyze_vision(frames, args.dry_run)

    log("步骤 3/4 analyze：产出 storyboard")
    board = analyze_storyboard(transcript, args.notes or "",
                               vision_brief, args.shots, args.dry_run)
    if board and not args.dry_run:
        with open(os.path.join(workdir, "remake_brief.json"), "w", encoding="utf-8") as f:
            json.dump(board, f, ensure_ascii=False, indent=2)

    log("步骤 4/4 generate + stitch")
    segs = generate_storyboard(board, frames, src_segments, workdir,
                               args.action_migration, args.dry_run)
    stitch(segs, args.output, args.dry_run)

    if not args.dry_run and board:
        write_report(args.output, board, src, args.action_migration, args.use_vision)
    log("完成。成品: " + args.output)


if __name__ == "__main__":
    main()
