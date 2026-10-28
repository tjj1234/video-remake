// 校验 index.html 的内联 JS 语法 + 关键逻辑存在性
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const DIR = "C:\\Users\\admin\\WorkBuddy\\2026-10-27-17-26-05\\video-remake-prototype";
const html = readFileSync(DIR + "\\index.html", "utf-8");
const out = [];
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; out.push("PASS  " + n); } else { fail++; out.push("FAIL  " + n + (d ? " :: " + d : "")); } };

// 抽出最后一个 <script> 块
const m = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
check("存在内联 script", m.length > 0);
const code = m[m.length - 1][1];

// 语法检查（不执行）
let syntaxOk = true, errMsg = "";
try { new vm.Script(code); } catch (e) { syntaxOk = false; errMsg = e.message; }
check("JS 语法可编译", syntaxOk, errMsg);

// 关键逻辑
check("统一端点 /v1/videos", code.includes('"/v1/videos"'));
check("不再有 /kling/v1/videos/motion-control", !code.includes("/kling/v1/videos/motion-control"));
check("不再有 /minimax/v2/video_generation", !code.includes("/minimax/v2/video_generation"));
check("不再有 /byteplus/", !code.includes("/byteplus/"));
check("参考视频 media.reference_video", code.includes('type: "reference_video"'));
check("CASTING RULE 存在", code.includes("CASTING RULE"));
check("禁止复现人物", code.includes("MUST NOT reproduce any person"));
check("换角开关元素", html.includes('id="swapCast"') && html.includes("checked"));
check("SEEDANCE_RE 黑名单存在", code.includes("SEEDANCE_RE") && code.includes("isSeedance"));
check("黑名单覆盖 seedance/seedream/dreamina", /seedance\|seedream\|\\bdreamina/.test(code));
check("supportsRefVideo 拦截 Seedance", /function supportsRefVideo[\s\S]{0,200}isSeedance\(m\)[\s\S]{0,40}return false/.test(code));
check("loadModels 过滤 Seedance", /loadModels[\s\S]{0,1200}!isSeedance\(id\)/.test(code));
check("运行前拦截 Seedance 并给替代", code.includes("不支持 Seedance 系列") && code.includes("REF_VIDEO_SUGGEST"));
check("提示已跳过 Seedance 数量", code.includes("已跳过"));
check("替代建议不含 seedance", !/REF_VIDEO_SUGGEST\s*=\s*"[^"]*seedance/i.test(code));
check("wan3 排除", code.includes('startsWith("wan3")'));
check("seconds 转字符串", code.includes("String(dur)"));
check("轮询路径 /v1/videos/{id}", code.includes('"/v1/videos/" + taskId'));
check("Key 存 localStorage", code.includes('localStorage.setItem("pt_key"'));
check("无外部依赖脚本", !/<script[^>]+src=/.test(html));
check("无后端 fetch 到非 PT 域", !/fetch\(\s*["'`]https?:\/\/(?!api\.powertokens\.ai)/.test(code));

const report = out.join("\n") + `\n\n通过 ${pass} / 共 ${pass + fail}`;
writeFileSync(DIR + "\\.htmltest.txt", report, "utf-8");
process.exitCode = fail ? 1 : 0;
