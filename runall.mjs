// 全量本地校验（无需 Key）：引擎契约 + 网页语法
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const NODE = process.execPath;
const DIR = "C:\\Users\\admin\\WorkBuddy\\2026-10-27-17-26-05\\video-remake-prototype";
const parts = [];

for (const [name, script, outFile] of [
  ["engine.mjs 契约与人物规则", "selftest.mjs", ".selftest.txt"],
  ["index.html 语法与逻辑", "htmltest.mjs", ".htmltest.txt"],
]) {
  let code = 0;
  try {
    execFileSync(NODE, [DIR + "\\" + script], { encoding: "utf-8", timeout: 180000 });
  } catch (e) { code = e.status ?? 1; }
  const body = existsSync(DIR + "\\" + outFile) ? readFileSync(DIR + "\\" + outFile, "utf-8") : "(无输出)";
  parts.push(`### ${name}  [exit=${code}]\n${body.trim()}`);
}

writeFileSync(DIR + "\\.alltests.txt", parts.join("\n\n"), "utf-8");
