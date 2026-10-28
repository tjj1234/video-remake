#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""remake.py 逻辑自测：mock/monkeypatch，不调真 API、不依赖 ffmpeg。"""
import importlib.util
import io
import json
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("remake", os.path.join(HERE, "remake.py"))
remake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remake)

PASS = []
FAIL = []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name + (f" | {extra}" if extra else ""))


# 1) 聊天契约 URL / 模型
check("CHAT_URL", remake.CHAT_URL == "https://api.powertokens.ai/v1/chat/completions",
      remake.CHAT_URL)
check("ANALYZE_MODEL default", remake.ANALYZE_MODEL == "deepseek-v4-pro")

# 2) ingest dry_run（不依赖 ffmpeg）
frames, transcript, segs = remake.ingest("fake.mp4", HERE, 3, dry_run=True)
check("ingest dry frames", len(frames) == 3, str(frames))
check("ingest dry src_segments", len(segs) == 3)
check("ingest dry transcript empty", transcript == "")

# 3) analyze_storyboard dry_run 产物形态
board = remake.analyze_storyboard("", "", None, 3, dry_run=True)
check("storyboard dry shots", len(board.get("shots", [])) == 3)
check("storyboard dry has new_script", "new_script" in board)

# 4)5) gen_one 命令拼装（用 fake_run 抓取真实命令，绕过 dry_run 不落盘问题）
# 模拟「ffmpeg 已抽出真实帧/片段」：让 exists 返回 True（仅自测用）
os.path.exists = lambda p: True
cmds = []
def fake_run(cmd, *a, **k):
    cmds.append(list(cmd))
    return types.SimpleNamespace(returncode=0)
remake.subprocess.run = fake_run

shot = {"index": 1, "duration": 5, "prompt_for_generation": "test shot", "use_ref_video": False}
remake.GEN_MODEL = "wan3.0-video"
remake.gen_one(shot, 1, frames, segs, HERE, use_motion=False, dry_run=False)
c = cmds[-1]
check("non-motion cmd has --ref", "--ref" in c, " ".join(c))
check("non-motion cmd has GEN_MODEL", "wan3.0-video" in c)

shot2 = {"index": 2, "duration": 5, "prompt_for_generation": "motion", "use_ref_video": True}
remake.MOTION_MODEL = "kling-v2-1-master"
remake.gen_one(shot2, 2, frames, segs, HERE, use_motion=True, dry_run=False)
c2 = cmds[-1]
check("motion cmd has --ref-video", "--ref-video" in c2, " ".join(c2))
check("motion cmd has MOTION_MODEL", "kling-v2-1-master" in c2)

# 6) JSON 鲁棒解析（兼容 ```json 围栏）
class FakeResp:
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self):
        return json.dumps({"choices": [{"message": {"content":
            "```json\n{\"hook\":\"x\",\"shots\":[{\"index\":1}]}\n```"}}]}).encode()
remake.urllib.request.urlopen = lambda *a, **k: FakeResp()
parsed = remake.call_chat("k", "deepseek-v4-pro", "sys", "user")
check("robust JSON parse fenced", parsed.get("hook") == "x" and "shots" in parsed)

# 7) 视觉报文含 image_url（monkeypatch 抓取 payload + 跳过真实读文件）
captured = {}
def fake_urlopen(req, *a, **k):
    captured["payload"] = json.loads(req.data.decode("utf-8"))
    fr = io.BytesIO(json.dumps({"choices": [{"message": {"content":
        '{"palette":"cool","visual_prompt":"cinematic"}'}}]}).encode())
    return fr
remake.urllib.request.urlopen = fake_urlopen
remake.img_to_dataurl = lambda p: "data:image/jpeg;base64,AAAA"  # 跳过真实读文件
remake.get_key = lambda: "sk-test-dummy"  # 自测不需要真 key
remake.VISION_MODEL = "deepseek-v4-pro"
vb = remake.analyze_vision(frames, dry_run=False)
content = captured.get("payload", {}).get("messages", [{}])[1].get("content", [])
has_img = any(isinstance(m, dict) and m.get("type") == "image_url" for m in content)
check("vision sends image_url", has_img)
check("vision returns brief", vb and vb.get("palette") == "cool")

# 8) stitch dry_run 不抛
try:
    remake.stitch(["a.mp4", "b.mp4"], os.path.join(HERE, "out.mp4"), dry_run=True)
    check("stitch dry ok", True)
except Exception as e:
    check("stitch dry ok", False, str(e))

# 汇总（自己写 UTF-8 报告，避免 PowerShell 管道乱码）
lines = [f"PASS={len(PASS)} FAIL={len(FAIL)}"]
for p in PASS:
    lines.append("  OK   " + p)
for f in FAIL:
    lines.append("  FAIL " + f)
with open(os.path.join(HERE, ".validate_report.txt"), "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines) + "\n")
sys.exit(1 if FAIL else 0)
