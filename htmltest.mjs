// 校验 index.html：语法 + 固定模型 + 三适配器 + 无用户可选模型
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const DIR = "C:\\Users\\admin\\WorkBuddy\\2026-10-27-17-26-05\\video-remake-prototype";
const html = readFileSync(DIR + "\\index.html", "utf-8");
const out = [];
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; out.push("PASS  " + n); } else { fail++; out.push("FAIL  " + n + (d ? " :: " + d : "")); } };

const ms = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
check("存在内联 script", ms.length > 0);
const code = ms[ms.length - 1][1];

let syntaxOk = true, errMsg = "";
try { new vm.Script(code); } catch (e) { syntaxOk = false; errMsg = e.message; }
check("JS 语法可编译", syntaxOk, errMsg);

// --- 用户不再选模型 ---
check("页面无模型下拉框", !/id="model"/.test(html));
check("页面无时长选择", !/id="duration"/.test(html));
check("页面无分辨率选择", !/id="resolution"/.test(html));
check("展示固定模型链", html.includes("Wan 2.7 r2v") && html.includes("MiniMax Hailuo 2.3") && html.includes("Kling v3 运镜"));

// --- 三适配器 ---
check("ADAPTERS 数组存在", code.includes("const ADAPTERS = ["));
check("含 wan2.7-r2v", code.includes('"wan2.7-r2v"'));
check("含 MiniMax-Hailuo-2.3", code.includes('"MiniMax-Hailuo-2.3"'));
check("含 kling-v3", code.includes('"kling-v3"'));
check("Wan 用 media.reference_video", code.includes('type: "reference_video"'));
check("MiniMax 用 image 字段", /image: o\.imageUrl/.test(code));
check("Kling 用原生运镜端点", code.includes("/kling/v1/videos/motion-control"));
check("Kling 用 model_name", code.includes("model_name: this.id"));
check("Kling 用 video_url", code.includes("video_url: o.sourceUrl"));
check("Kling 用 character_orientation", code.includes("character_orientation: charOrient"));

// --- 自动匹配时长尺寸 ---
check("有 loadVideoEl 探测", code.includes("loadVideoEl"));
check("有 grabFrame 抽帧", code.includes("async function grabFrame"));
check("canvas 转 dataURL", code.includes('toDataURL("image/jpeg"'));
check("有 guessRatio", code.includes("function guessRatio"));
check("有 nearestSize", code.includes("function nearestSize"));
check("短边>=960 -> pro", code.includes('>= 960 ? "pro" : "std"'));
check("MiniMax 只有 6/10", code.includes('<= 8 ? "6" : "10"'));
check("MiniMax 10s 强制 768P", code.includes('if (dur === "10") size = "768P"'));

// --- 自动降级 ---
check("for 循环降级", /for \(let i = 0; i < ADAPTERS\.length; i\+\+\)/.test(code));
check("失败继续下一个", code.includes("降级下一个"));
check("有结果汇总", code.includes("=== 结果汇总 ==="));

// --- 换角 + Seedance ---
check("CASTING RULE", code.includes("CASTING RULE"));
check("Seedance 黑名单", code.includes("SEEDANCE_RE") && code.includes("isSeedance"));
check("Seedance 被跳过", code.includes("if (isSeedance(ad.id)) continue"));

// --- 安全 ---
check("无外部脚本依赖", !/<script[^>]+src=/.test(html));
check("只调 PT 域名", !/fetch\(\s*["'`]https?:\/\/(?!api\.powertokens\.ai)/.test(code));

writeFileSync(DIR + "\\.htmltest.txt", out.join("\n") + `\n\n通过 ${pass} / 共 ${pass + fail}`, "utf-8");
process.exitCode = fail ? 1 : 0;
