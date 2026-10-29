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
// 实测：MiniMax 的 image 非必填，页面按「有图才带」实现
check("MiniMax 的 image 按需附带（可选）", /if \(o\.imageUrl\) body\.image = o\.imageUrl/.test(code));
check("MiniMax 不再强制要求参考图", !/throw new Error\("需要参考帧（image 必填）/.test(code));
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

// --- 回归：ratio 绝不能是 adaptive（wan2.7-r2v 会 400）---
check("guessRatio 不返回 adaptive", !/return\s+["']adaptive["']/.test(code));
check("上传图可推断画幅（guessRatio 被 re-used）", code.includes("guessRatio(meta.width, meta.height)"));

// --- 回归：必须有手动上传参考图的入口 ---
check("有文件选择 input", /<input[^>]+type="file"[^>]+id="refFile"/.test(html));
check("有拖拽区 drop", /id="drop"/.test(html));
check("有预览图 refPreview", /id="refPreview"/.test(html));
check("有清除按钮 refClear", /id="refClear"/.test(html));
check("有 fileToDataUrl 压缩函数", code.includes("function fileToDataUrl"));
check("文件体积上限保护（maxSide）", code.includes("1280"));
check("参考图优先级：上传 > 自动抽帧", code.indexOf("if (userRef && userRef.dataUrl)") > 0
  && code.indexOf("if (userRef && userRef.dataUrl)") < code.indexOf("else if (!refImage)"));
check("缺图时给出可操作提示", code.includes("上传一张原视频的人物截图"));
check("拖拽有阻止浏览器打开图片", code.includes('window.addEventListener("drop"'));

// --- 回归：平台分享页必须被提前拦下（YouTube 实测会报 Invalid data）---
{
  const sandbox = { URL };
  const hostsSrc = code.match(/const PAGE_HOSTS = \[[\s\S]*?\];/)[0];
  const fnSrc = code.match(/function detectPageHost\(raw\) \{[\s\S]*?\n\}/)[0];
  vm.runInNewContext(hostsSrc + "\n" + fnSrc + "\nthis._detect = detectPageHost;", sandbox);
  const d = sandbox._detect;
  check("识别 YouTube 播放页", d("https://www.youtube.com/watch?v=GnsiYACM5ng") === "YouTube", String(d("https://www.youtube.com/watch?v=GnsiYACM5ng")));
  check("识别 youtu.be 短链", d("https://youtu.be/GnsiYACM5ng") === "YouTube");
  check("识别抖音分享页", d("https://www.douyin.com/video/123") === "抖音");
  check("识别 B站", d("https://www.bilibili.com/video/BV1xx") === "B站");
  check("识别 TikTok", d("https://www.tiktok.com/@a/video/1") === "TikTok");
  check("真实 mp4 直链不被误判", d("https://cdn.example.com/a/b.mp4") === null);
  check("其他域名的页面不误杀", d("https://example.com/watch?v=1") === null);
}
check("有 detectPageHost 函数", code.includes("function detectPageHost"));
check("有 PAGE_HOSTS 平台表", code.includes("const PAGE_HOSTS"));
check("resolveSourceUrl 会拦平台页", code.includes("detectPageHost(u)"));

// --- 回归：网页版轮询必须用 pollPath（曾误用 path → 永远轮询不到完成）---
check("网页版轮询用 built.pollPath（非 built.path）", code.includes("built.pollPath.replace"),
  "轮询端点必须基于 pollPath（含 {id} 的任务端点）");
check("网页版轮询未误用 built.path 拼 {id}", !code.includes('built.path.replace("{id}"'),
  "曾误用 built.path（创建端点），导致轮询列表接口、永远拿不到任务状态");

// --- 回归：Wan size 无 480P ---
check("页面 Wan 适配器不含 480P", !/nearestSize\(\["480P"/.test(code));

// --- 安全 ---
check("无外部脚本依赖", !/<script[^>]+src=/.test(html));
check("只调 PT 域名", !/fetch\(\s*["'`]https?:\/\/(?!api\.powertokens\.ai)/.test(code));

writeFileSync(DIR + "\\.htmltest.txt", out.join("\n") + `\n\n通过 ${pass} / 共 ${pass + fail}`, "utf-8");
process.exitCode = fail ? 1 : 0;
