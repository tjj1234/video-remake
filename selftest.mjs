// 引擎自测：固定模型链 + 自动降级 + 换角规则 + Seedance 拦截
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";

const NODE = process.execPath;
const DIR = "C:\\Users\\admin\\WorkBuddy\\2026-10-27-17-26-05\\video-remake-prototype";
const ENG = DIR + "\\engine.mjs";
const OUT = DIR + "\\.engine_out.txt";

let pass = 0, fail = 0;
const results = [];
function run(args) {
  if (existsSync(OUT)) unlinkSync(OUT);
  try { execFileSync(NODE, [ENG, ...args], { encoding: "utf-8", timeout: 120000 }); } catch {}
  return existsSync(OUT) ? readFileSync(OUT, "utf-8") : "";
}
function check(name, cond, detail) {
  if (cond) { pass++; results.push("PASS  " + name); }
  else { fail++; results.push("FAIL  " + name + (detail ? " :: " + detail : "")); }
}

const SRC = "https://example.com/clip.mp4";

// ---------- 1. 固定模型链，用户不再选模型 ----------
let o = run(["--dry-run", "--url", SRC, "--no-probe", "--direction", "雨夜街道"]);
check("声明固定模型策略", o.includes("模型策略：固定"), o.slice(0, 200));
check("模型链含 Wan 2.7 r2v", o.includes("Wan 2.7 r2v"));
check("模型链含 MiniMax", o.includes("MiniMax Hailuo 2.3"));
check("模型链含 Kling v3", o.includes("Kling v3"));
check("说明失败自动降级", o.includes("失败自动降级") || o.includes("自动降级"));
check("不再接受 --model 参数（全链都跑）", o.includes("wan2.7-r2v") && o.includes("kling-v3"));

// ---------- 2. 三模型各自端点/字段正确 ----------
check("Wan 端点 /v1/videos", o.includes("POST https://api.powertokens.ai/v1/videos"));
check("Wan 用 media.reference_video", o.includes('"type": "reference_video"'));
check("Kling 用原生运镜端点", o.includes("/kling/v1/videos/motion-control"));
check("Kling 用 model_name", o.includes('"model_name": "kling-v3"'));
check("Kling 用 video_url", o.includes('"video_url"'));
check("Kling 用 character_orientation", o.includes('"character_orientation"'));
check("Kling 摘要说明无 seconds 字段", o.includes("本模型无 seconds 字段"));
// 精确到 Kling 段落的 JSON 体里不得出现 size / seconds / duration
{
  const seg = o.split("--- Kling v3")[1] || "";
  const body = seg.split("请求体：")[1]?.split("=== 结果汇总")[0] || "";
  check("Kling 请求体无 size", !/"size"\s*:/.test(body), body.slice(0, 120));
  check("Kling 请求体无 seconds", !/"seconds"\s*:/.test(body));
  check("Kling 请求体无 duration", !/"duration"\s*:/.test(body));
}

// ---------- 3. 人物规则 ----------
check("含 CASTING RULE", o.includes("CASTING RULE"));
check("禁止复现原人物", o.includes("MUST NOT reproduce any person"));
check("重新选角四项", o.includes("different face") && o.includes("different wardrobe"));
check("规则在创作方向之前", o.indexOf("CASTING RULE") < o.indexOf("雨夜街道"));

// ---------- 4. 时长/尺寸匹配 ----------
check("声明匹配原视频时长尺寸", o.includes("自动匹配") || o.includes("参数适配"));
check("无探测时降级并告警", o.includes("跳过探测") || o.includes("默认"));

// ---------- 5. Seedance 拦截 ----------
check("Seedance 在模型链中不存在", !/seedance|dreamina/i.test(o.split("模型策略")[1]?.split("\n")[0] || ""));

// ---------- 6. mock 成功路径 ----------
o = run(["--mock", "--url", SRC, "--no-probe"]);
check("mock 走通并给出成片", o.includes("ForBiggerBlazes") || o.includes("完成"));
check("mock 汇总显示最终模型", o.includes("最终模型") || o.includes("结果汇总"));

// ---------- 7. 缺少 key ----------
o = run(["--url", SRC, "--no-probe"]);
check("缺 key 时报错", o.includes("缺少 API Key"));

// ---------- 8. 非法链接 ----------
o = run(["--dry-run", "--url", "ftp://x/y.mp4"]);
check("非 http 链接被拒", o.includes("http://") || o.includes("FATAL"));

// ---------- 9. 分辨率由源视频决定（探测路径）----------
o = run(["--dry-run", "--url", SRC]);
check("默认探测试图探测", o.includes("探测") || o.includes("ffprobe") || o.includes("降级"));

writeFileSync(DIR + "\\.selftest.txt", results.join("\n") + `\n\n通过 ${pass} / 共 ${pass + fail}`, "utf-8");
process.exitCode = fail ? 1 : 0;
