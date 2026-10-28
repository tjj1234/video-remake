// 模型适配器：每个模型独立封装「端点 / 字段名 / 取值枚举 / 约束」
//
// 重要：PT 视频模型**不是**一套统一契约。官方文档实测确认：
//   Wan 系      → POST /v1/videos              （prompt + media[] + size + ratio + seconds）
//   Kling 运镜   → POST /kling/v1/videos/motion-control （model_name + image_url + video_url + character_orientation + mode）
//   Kling Omni  → POST /kling/v1/videos/omni-video      （model_name + video_list[] + duration + aspect_ratio）
//   MiniMax     → POST /v1/videos              （image 必填 + seconds + size，仅 768P/1080P，仅 6/10s）
//
// 每个适配器负责把「用户意图（源视频时长/尺寸）」翻译成「该模型自己的合法取值」，
// 上层不需要知道任何模型差异。

import { guessRatio, orientation } from "./probe.mjs";

const PT_BASE = "https://api.powertokens.ai";

// ---------- 通用工具 ----------
// 从候选枚举里选最接近目标值的一项
function nearest(candidates, target) {
  let best = candidates[0], diff = Infinity;
  for (const c of candidates) {
    const d = Math.abs(Number(c) - Number(target));
    if (d < diff) { diff = d; best = c; }
  }
  return best;
}
// 从候选分辨率档位里选最接近源视频短边的一项
function nearestSize(candidates, shortSide) {
  const map = { 480: 480, 720: 720, 768: 768, 1080: 1080 };
  let best = candidates[0], diff = Infinity;
  for (const c of candidates) {
    const px = map[parseInt(c, 10)] ?? parseInt(c, 10);
    const d = Math.abs(px - (shortSide || 720));
    if (d < diff) { diff = d; best = c; }
  }
  return best;
}

// ============================================================
// 适配器 1：Wan 2.7 r2v —— 首选。纯 URL 参考视频，无需抽帧
// ============================================================
const wanR2V = {
  id: "wan2.7-r2v",
  label: "Wan 2.7 r2v",
  endpoint: "/v1/videos",
  pollPath: "/v1/videos/{id}",
  needsImage: false,          // 不需要参考图
  needsFrameExtract: false,
  strengths: "参考视频直传、参数最省心、成本最低",
  // 官方约束：size ∈ {480P,720P,1080P}；seconds 2-30（有视频输入时 输入+输出 ≤30）；ratio ∈ adaptive/16:9/4:3/1:1/3:4/9:16
  fit(src, prompt, opts = {}) {
    const dur = this.fitDuration(src, opts);
    const size = nearestSize(["480P", "720P", "1080P"], src.shortSide);
    const body = {
      model: this.id,
      prompt,
      size,
      ratio: guessRatio(src.width, src.height),
      seconds: String(dur),
      generate_audio: opts.sound !== false,
      prompt_extend: true,
      watermark: false,
      media: [{ type: "reference_video", url: opts.sourceUrl }],
    };
    return { path: this.endpoint, pollPath: this.pollPath, body, applied: { dur, size } };
  },
  fitDuration(src, opts) {
    // 用户要「和原视频一样长」：取原视频时长，但受模型上限 + 参考视频共同占用 30s 的约束
    const want = Math.round(src.duration || opts.duration || 5);
    const cap = Math.max(2, 30 - Math.ceil(src.duration || 0));
    return Math.min(Math.max(2, want), Math.min(10, cap));
  },
};

// ============================================================
// 适配器 2：Wan 3.0 —— 备用。同样 /v1/videos，但 size 默认 1080P 需显式覆盖
// ============================================================
const wan30 = {
  id: "wan3.0-video",
  label: "Wan 3.0",
  endpoint: "/v1/videos",
  pollPath: "/v1/videos/{id}",
  needsImage: false,
  needsFrameExtract: false,
  strengths: "支持 -1 智能时长；标准版性价比高",
  fit(src, prompt, opts = {}) {
    const dur = this.fitDuration(src, opts);
    // ⚠️ 官方 size 默认值是 1080P（最高价），必须显式传档位
    const size = nearestSize(["480P", "720P", "1080P"], src.shortSide);
    const body = {
      model: this.id,
      prompt,
      size,
      ratio: guessRatio(src.width, src.height),
      seconds: String(dur),
      generate_audio: opts.sound !== false,
      prompt_extend: true,
      watermark: false,
      media: [{ type: "reference_video", url: opts.sourceUrl }],
    };
    return { path: this.endpoint, pollPath: this.pollPath, body, applied: { dur, size } };
  },
  fitDuration(src, opts) {
    const want = Math.round(src.duration || opts.duration || 5);
    const cap = Math.max(2, 30 - Math.ceil(src.duration || 0));
    return Math.min(Math.max(2, want), Math.min(10, cap));
  },
};

// ============================================================
// 适配器 3：Kling v3 运镜控制 —— 端点/字段全不同，且 image_url 必填
// ============================================================
const klingMotion = {
  id: "kling-v3",
  label: "Kling v3 运镜",
  endpoint: "/kling/v1/videos/motion-control",
  pollPath: "/kling/v1/videos/motion-control",
  needsImage: true,           // ⚠️ image_url 必填
  needsFrameExtract: true,    // 需从源视频抽一帧
  strengths: "动作/运镜还原最强（原样继承源视频动作）",
  // 官方约束：mode ∈ {std(720P), pro(1080P)}；无 size/seconds；时长由参考视频决定
  //   character_orientation=image → 参考视频 ≤10s；=video → ≤30s
  //   keep_original_sound ∈ {yes,no}；prompt ≤2500
  fit(src, prompt, opts = {}) {
    // image_url 是必填项：没有图直接报错，绝不发出 image_url=null 的请求
    if (!opts.imageUrl) {
      throw new Error("Kling 运镜需要参考图（image_url 必填），但未取到图：请从源视频抽帧，或手动上传一张截图。");
    }
    const short = src.shortSide || 720;
    // 源视频短边 ≥ 960 视为想要高清 → pro(1080P)，否则 std(720P)
    const mode = short >= 960 ? "pro" : "std";
    // 竖屏/方形用 image 朝向（≤10s 限制），横屏用 video 朝向
    const orient = orientation(src.width, src.height);
    const charOrient = orient === "landscape" ? "video" : "image";
    // 时长：运镜模式不支持指定秒数，由参考视频长度决定；此处仅做可行性校验
    const refDur = src.duration || 0;
    const maxRefDur = charOrient === "image" ? 10 : 30;
    if (refDur > maxRefDur) {
      throw new Error(
        `Kling 运镜在 character_orientation=${charOrient} 下参考视频不能超过 ${maxRefDur}s，` +
        `源视频 ${refDur.toFixed(1)}s 超限。请改用 Wan 模型，或先裁剪源视频。`
      );
    }

    // 运镜模式没有 seconds/size 字段：时长与画幅由参考视频继承，
    // 能调的只有清晰度档位（mode），所以单独给一句中文说明。
    const note =
      `参数适配：时长=沿用源视频${refDur ? ` ${refDur.toFixed(1)}s` : ""}（本模型无 seconds 字段）` +
      `  清晰度=${mode === "pro" ? "pro(1080P)" : "std(720P)"}` +
      `  方向=${charOrient}`;

    const body = {
      model_name: this.id,
      mode,
      image_url: opts.imageUrl,        // 抽帧后的参考图 URL（必填）
      video_url: opts.sourceUrl,       // 源视频（必填）
      prompt: String(prompt || "").slice(0, 2500),
      character_orientation: charOrient,
      keep_original_sound: opts.sound === false ? "no" : "yes",
    };
    return {
      path: this.endpoint, pollPath: this.pollPath, body,
      applied: { mode, charOrient, dur: refDur, note },
    };
  },
};

// ============================================================
// 适配器 4：MiniMax-Hailuo-2.3 —— 只有 768P/1080P，只有 6/10s，且 image 必填
// ============================================================
const minimax = {
  id: "MiniMax-Hailuo-2.3",
  label: "MiniMax Hailuo 2.3",
  endpoint: "/v1/videos",
  pollPath: "/v1/videos/{id}",
  needsImage: true,
  needsFrameExtract: true,
  strengths: "支持 [指令] 运镜语法",
  // 官方约束：size ∈ {768P, 1080P}（没有 720P）；seconds ∈ {6,10}；
  //   10s 时 1080P 不可用（只有 768P）
  fit(src, prompt, opts = {}) {
    // image 是必填项：没有图直接报错，绝不发出 image=undefined 的请求
    if (!opts.imageUrl) {
      throw new Error("MiniMax 需要参考图（image 必填），但未取到图：请从源视频抽帧，或手动上传一张截图。");
    }
    const want = src.duration || 6;
    // 时长只能 6 或 10：≤8s 选 6，>8s 选 10
    const dur = want <= 8 ? "6" : "10";
    // 尺寸 768P/1080P：源短边 ≥960 且时长为 6s 才允许 1080P
    const preferHi = (src.shortSide || 0) >= 960;
    let size = preferHi ? "1080P" : "768P";
    if (dur === "10" && size === "1080P") size = "768P";   // 10s 强制 768P
    const body = {
      model: this.id,
      image: opts.imageUrl,          // 起始帧（必填）
      prompt: String(prompt || "").slice(0, 2000),
      seconds: dur,
      size,
    };
    return { path: this.endpoint, pollPath: this.pollPath, body, applied: { dur, size } };
  },
};

// ---------- 注册表：按优先级排列（固定，不由用户选择）----------
// 顺序即降级顺序。用户无感，只看到「最终用了哪个模型」。
export const MODEL_CHAIN = [wanR2V, minimax, klingMotion];

export const ADAPTERS = { [wanR2V.id]: wanR2V, [wan30.id]: wan30, [klingMotion.id]: klingMotion, [minimax.id]: minimax };

export function getAdapter(id) { return ADAPTERS[id] || null; }

// ---------- 端点是原生厂商格式还是统一格式 ----------
export function isNativeEndpoint(adapter) { return adapter.endpoint.startsWith("/kling/"); }

export { PT_BASE, nearest, nearestSize };
