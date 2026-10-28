// 自测脚本：验证 engine.mjs 契约与人物规则（不消耗 API 额度）
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";

const NODE = process.execPath;
const DIR = "C:\\Users\\admin\\WorkBuddy\\2026-10-27-17-26-05\\video-remake-prototype";
const ENG = DIR + "\\engine.mjs";
const OUT = DIR + "\\.engine_out.txt";

let pass = 0, fail = 0;
const results = [];

function run(args) {
  if (existsSync(OUT)) unlinkSync(OUT);
  try {
    execFileSync(NODE, [ENG, ...args], { encoding: "utf-8", timeout: 60000 });
  } catch (e) { /* 非零退出也读输出 */ }
  return existsSync(OUT) ? readFileSync(OUT, "utf-8") : "";
}
function check(name, cond, detail) {
  if (cond) { pass++; results.push("PASS  " + name); }
  else { fail++; results.push("FAIL  " + name + (detail ? " :: " + detail : "")); }
}

const SRC = "https://example.com/clip.mp4";

// 1. dry-run 契约：统一 /v1/videos
let o = run(["--dry-run", "--url", SRC, "--model", "kling-v2-1-master", "--direction", "雨夜街道"]);
check("统一端点 /v1/videos", o.includes("POST https://api.powertokens.ai/v1/videos"), o.slice(0, 200));
check("不再拼 /kling/ 厂商路径", !o.includes("/kling/v1/videos/motion-control"));
check("参考视频走 media.reference_video", o.includes('"type": "reference_video"'));
check("seconds 为字符串", o.includes('"seconds": "5"'));
check("size 大写 720P", o.includes('"size": "720P"'));

// 2. 人物规则强制前置
check("含 CASTING RULE", o.includes("CASTING RULE"));
check("禁止复现原人物", o.includes("MUST NOT reproduce any person"));
check("重新选角四项", o.includes("different face") && o.includes("different wardrobe"));
check("规则在创作方向之前", o.indexOf("CASTING RULE") < o.indexOf("雨夜街道"));

// 3. 换模型
o = run(["--dry-run", "--url", SRC, "--model", "wan2.7-r2v"]);
check("wan2.7-r2v 支持参考视频", o.includes('"model": "wan2.7-r2v"') && o.includes("reference_video"));

// 4. 不支持参考视频的模型应被拒
o = run(["--dry-run", "--url", SRC, "--model", "seedance-1-5-pro-251215"]);
check("seedance 被拒（需 asset://）", o.includes("不接受参考视频"));
o = run(["--dry-run", "--url", SRC, "--model", "wan3.0-video"]);
check("wan3.0 被拒（不收参考视频）", o.includes("不接受参考视频"));

// 5. 图片模型被拒
o = run(["--dry-run", "--url", SRC, "--model", "seedream-5-0-260128"]);
check("图片模型被拒", o.includes("不能用于视频重制"));

// 6. 非法链接
o = run(["--dry-run", "--url", "ftp://x/y.mp4"]);
check("非 http 链接被拒", o.includes("http://") || o.includes("FATAL"));

// 7. 分辨率映射
o = run(["--dry-run", "--url", SRC, "--resolution", "1080p"]);
check("1080p 映射为 1080P", o.includes('"size": "1080P"'));

// 8. 时长边界
o = run(["--dry-run", "--url", SRC, "--duration", "99"]);
check("时长上限 30", o.includes('"seconds": "30"'));
o = run(["--dry-run", "--url", SRC, "--duration", "1"]);
check("时长下限 2", o.includes('"seconds": "2"'));

// 9. 声音
o = run(["--dry-run", "--url", SRC, "--sound"]);
check("声音开关生效", o.includes('"generate_audio": true'));

// 10. mock 成功路径
o = run(["--mock", "--url", SRC, "--direction", "测试"]);
check("mock 走通并给出结果", o.includes("演示模式") && o.includes("ForBiggerBlazes"));

// 11. 无 key 真跑应报缺 key
o = run(["--url", SRC]);
check("缺 key 时报错而非静默", o.includes("缺少 API Key"));

// 12. dry-run 不扣费
o = run(["--dry-run", "--url", SRC]);
check("dry-run 声明未提交", o.includes("未提交"));

const report = results.join("\n") + `\n\n通过 ${pass} / 共 ${pass + fail}`;
execFileSync(NODE, ["-e", `require("fs").writeFileSync(${JSON.stringify(DIR + "\\.selftest.txt")}, ${JSON.stringify(report)}, "utf-8")`]);
process.exitCode = fail ? 1 : 0;
