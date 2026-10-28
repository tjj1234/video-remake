// 模型适配器：每个模型独立封装「端点 / 字段名 / 取值枚举 / 约束」
//
// ⚠️ 全部约束均来自 2026-10-28 对 https://api.powertokens.ai 的真实请求实测，
//    不是从文档推断的。实测方法与证据见仓库 README 的「实测契约」一节。
//
// 关键实测结论（覆盖了三处早期错误认知）：
//   1. wan2.7-r2v 的参考视频走 media:[{type:"reference_video", url}]，
//      且 **media 与 subject_reference 互斥**——同时给会 400
//      "media cannot be used together with subject_reference"。
//   2. MiniMax-Hailuo-2.3 的 image **不是必填**（不带 image 也能通过校验），
//      seconds **有默认值**；但 size 只认 768P/1080P（传 720P → pricing rule not found），
//      seconds 只认 6/10（传 5 → pricing rule not found）。
//   3. Kling 运镜端点模型名必须叫 kling-v3；字段为 model_name/image_url/video_url/
//      character_orientation/mode，无 size/seconds。
//
// 三个模型的费用量级差异巨大（实测报价）：
//   wan2.7-r2v 5s 720P ≈ $0.475
//   MiniMax 6s 768P    ≈ $0.266
//   Kling 运镜 std     ≈ 未知（按源视频时长计）
// 因此降级链按「便宜且不烧钱失败」排序。

// ---------- 通用工具 ----------
const PT_BASE = "https://api.powertokens.ai";

function nearest(candidates, target) {
  let best = candidates[0], diff = Infinity;
  for (const c of candidates) {
    const d = Math.abs(Number(c) - Number(target));
    if (d < diff) { diff = d; best = c; }
  }
  return best;
}

// Wan 系的合法 ratio 枚举。实测 wan2.7-r2v 与 wan3.0 都只认这 5 个，
// 传 adaptive 会 400（"only supports ratio 16:9, 9:16, 1:1, 4:3, or 3:4"）。
export const WAN_RATIOS = [
  ["16:9", 16 / 9],
  ["4:3", 4 / 3],
  ["1:1", 1],
  ["3:4", 3 / 4],
  ["9:16", 9 / 16],
];

// 把任意宽高比收敛到最近的合法枚举项。绝不返回 adaptive。
export function guessRatio(width, height) {
  if (!width || !height) return "16:9";
  const r = width / height;
  let best = WAN_RATIOS[0], bestDiff = Infinity;
  for (const t of WAN_RATIOS) {
    const d = Math.abs(r - t[1]);
    if (d < bestDiff) { bestDiff = d; best = t; }
  }
  return best[0];
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

function orientation(width, height) {
  if (!width || !height) return "landscape";
  if (width > height * 1.05) return "landscape";
  if (height > width * 1.05) return "portrait";
  return "square";
}

// ============================================================
// 适配器 1：Wan 2.7 r2v —— 参考视频直传，无需抽帧，参数最省心
// ============================================================
const wanR2V = {
  id: "wan2.7-r2v",
  label: "Wan 2.7 r2v",
  endpoint: "/v1/videos",
  pollPath: "/v1/videos/{id}",
  needsImage: false,
  needsFrameExtract: false,
  strengths: "参考视频直传、无需抽帧、动作继承最好",
  // 实测约束：
  //   size   ∈ {720P, 1080P}（无 480P，传 480P → "only supports 720P or 1080P"）
  //   ratio  ∈ WAN_RATIOS（无 adaptive）
  //   seconds ∈ 2..30 的字符串；有视频输入时 输入时长 + 输出时长 ≤ 30
  //   media  = [{type:"reference_video", url:"<mp4 直链>"}]
  //   ⚠️ media 与 subject_reference 互斥
  fit(src, prompt, opts = {}) {
    if (!opts.sourceUrl) {
      throw new Error("Wan 2.7 r2v 需要参考视频（media[].url 必填），但源视频 URL 为空。");
    }
    const dur = this.fitDuration(src, opts);
    const size = nearestSize(["720P", "1080P"], src.shortSide);
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
    return {
      path: this.endpoint,
      pollPath: this.pollPath,
      body,
      applied: { dur, size, ratio: body.ratio },
    };
  },
  fitDuration(src, opts) {
    // 目标「和原视频一样长」：受两个上限夹逼
    //   a) 输出上限 10s（再长性价比崩，且多数场景用不到）
    //   b) 输入 + 输出 ≤ 30s，即输出 ≤ 30 - ceil(输入时长)
    const want = Math.round(src.duration || opts.duration || 5);
    const refDur = Math.ceil(src.duration || 0);
    const cap = Math.max(2, 30 - refDur);
    return Math.min(Math.max(2, want), Math.min(10, cap));
  },
};

// ============================================================
// 适配器 2：MiniMax-Hailuo-2.3 —— 最便宜的一档（实测 6s 768P ≈ $0.266）
// ============================================================
const minimax = {
  id: "MiniMax-Hailuo-2.3",
  label: "MiniMax Hailuo 2.3",
  endpoint: "/v1/videos",
  pollPath: "/v1/videos/{id}",
  // ⚠️ 实测修正：image 不是必填。没有图也能通过校验（服务端会按 prompt 生成）。
  //    但图生视频的动作更贴近原视频，所以有图时仍然会带上。
  needsImage: false,
  needsFrameExtract: false,
  strengths: "最便宜（6s 768P ≈ $0.266）、支持 [指令] 运镜语法",
  // 实测约束：
  //   size    ∈ {768P, 1080P}——传 720P → 400 "pricing rule not found"
  //   seconds ∈ {6, 10}——传 5 → 400 "pricing rule not found"；不传则有默认值
  //   10s 时 1080P 不可用（400），必须降到 768P
  fit(src, prompt, opts = {}) {
    const want = src.duration || 6;
    // 时长只能 6 或 10：≤8s 选 6，>8s 选 10
    const dur = want <= 8 ? "6" : "10";
    // 尺寸 768P/1080P：源短边 ≥960 且时长为 6s 才允许 1080P
    let size = (src.shortSide || 0) >= 960 ? "1080P" : "768P";
    if (dur === "10" && size === "1080P") size = "768P";   // 10s 强制 768P

    const body = {
      model: this.id,
      prompt: String(prompt || "").slice(0, 2000),
      seconds: dur,
      size,
    };
    // image 可选：有就带（图生视频，动作更像原视频）；没有也能跑
    if (opts.imageUrl) body.image = opts.imageUrl;

    return {
      path: this.endpoint,
      pollPath: this.pollPath,
      body,
      applied: { dur, size, hasImage: !!opts.imageUrl, ratio: "由参考图决定" },
    };
  },
};

// ============================================================
// 适配器 3：Kling v3 运镜 —— 端点/字段全不同；动作还原最强
// ============================================================
const klingMotion = {
  id: "kling-v3",
  label: "Kling v3 运镜",
  endpoint: "/kling/v1/videos/motion-control",
  pollPath: "/kling/v1/videos/motion-control",
  needsImage: true,
  needsFrameExtract: true,
  strengths: "动作/运镜还原最强（原样继承源视频动作）",
  // 实测约束：
  //   model_name 必须是 "kling-v3"（不传 → 400 "Model name not specified"）
  //   image_url / video_url 必填；image_url 是「人物主体图」，video_url 是「动作参考视频」
  //   mode ∈ {std(720P), pro(1080P)}
  //   character_orientation ∈ {image, video}
  //     image → 参考视频 ≤10s；video → ≤30s
  //   keep_original_sound ∈ {yes, no}
  //   无 size / seconds 字段
  fit(src, prompt, opts = {}) {
    // image_url 真的是必填项（实测：不传会 400）
    if (!opts.imageUrl) {
      throw new Error("Kling 运镜需要人物主体图（image_url 必填），但未取到图：请从源视频抽帧，或手动上传一张截图。");
    }
    if (!opts.sourceUrl) {
      throw new Error("Kling 运镜需要动作参考视频（video_url 必填），但源视频 URL 为空。");
    }
    const short = src.shortSide || 720;
    const mode = short >= 960 ? "pro" : "std";
    const orient = orientation(src.width, src.height);
    const charOrient = orient === "landscape" ? "video" : "image";

    const refDur = src.duration || 0;
    const maxRefDur = charOrient === "image" ? 10 : 30;
    if (refDur > maxRefDur) {
      throw new Error(
        `Kling 运镜在 character_orientation=${charOrient} 下参考视频不能超过 ${maxRefDur}s，` +
        `源视频 ${refDur.toFixed(1)}s 超限。请改用 Wan 模型，或先裁剪源视频。`
      );
    }

    const note =
      `参数适配：时长=沿用源视频${refDur ? ` ${refDur.toFixed(1)}s` : ""}（本模型无 seconds 字段）` +
      `  清晰度=${mode === "pro" ? "pro(1080P)" : "std(720P)"}` +
      `  方向=${charOrient}`;

    const body = {
      model_name: this.id,
      mode,
      image_url: opts.imageUrl,
      video_url: opts.sourceUrl,
      prompt: String(prompt || "").slice(0, 2500),
      character_orientation: charOrient,
      keep_original_sound: opts.sound === false ? "no" : "yes",
    };
    return {
      path: this.endpoint,
      pollPath: this.pollPath,
      body,
      applied: { mode, charOrient, dur: refDur, note },
    };
  },
};

// ============================================================
// 适配器 4：Wan 3.0 —— 备用，同为 /v1/videos 但 media.type 枚举更宽
// ============================================================
const wan30 = {
  id: "wan3.0-video",
  label: "Wan 3.0",
  endpoint: "/v1/videos",
  pollPath: "/v1/videos/{id}",
  needsImage: false,
  needsFrameExtract: false,
  strengths: "支持 reference_image / reference_audio 多模态参考",
  // 实测：wan3.0 支持 media.type ∈ {reference_video, reference_image, reference_audio}
  //       不支持裸 "video" / "image" / "audio"（400 unsupported media.type for wan3.0）
  fit(src, prompt, opts = {}) {
    if (!opts.sourceUrl) {
      throw new Error("Wan 3.0 需要参考视频（media[].url 必填），但源视频 URL 为空。");
    }
    const dur = this.fitDuration(src, opts);
    const size = nearestSize(["720P", "1080P"], src.shortSide);
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
    const refDur = Math.ceil(src.duration || 0);
    const cap = Math.max(2, 30 - refDur);
    return Math.min(Math.max(2, want), Math.min(10, cap));
  },
};

// ============================================================
// 适配器 5：HappyHorse 1.1 r2v —— 实测支持 reference_video，作为最末兜底
// ============================================================
const happyhorseR2V = {
  id: "happyhorse-1.1-r2v",
  label: "HappyHorse 1.1 r2v",
  endpoint: "/v1/videos",
  pollPath: "/v1/videos/{id}",
  needsImage: false,
  needsFrameExtract: false,
  strengths: "同为参考视频驱动，作为兜底链路",
  fit(src, prompt, opts = {}) {
    if (!opts.sourceUrl) {
      throw new Error("HappyHorse 1.1 r2v 需要参考视频（media[].url 必填），但源视频 URL 为空。");
    }
    const dur = this.fitDuration(src, opts);
    const size = nearestSize(["720P", "1080P"], src.shortSide);
    const body = {
      model: this.id,
      prompt,
      size,
      ratio: guessRatio(src.width, src.height),
      seconds: String(dur),
      media: [{ type: "reference_video", url: opts.sourceUrl }],
    };
    return { path: this.endpoint, pollPath: this.pollPath, body, applied: { dur, size } };
  },
  fitDuration(src, opts) {
    const want = Math.round(src.duration || opts.duration || 5);
    const refDur = Math.ceil(src.duration || 0);
    const cap = Math.max(2, 30 - refDur);
    return Math.min(Math.max(2, want), Math.min(10, cap));
  },
};

// ---------- 注册表：按优先级排列（固定，不由用户选择）----------
// 顺序即降级顺序。用户无感，只看到「最终用了哪个模型」。
// 排序依据：先选「便宜且失败不烧钱」的，再选「能力强的」。
//   MiniMax 6s 768P ≈ $0.266（最便宜）
//   wan2.7-r2v 5s 720P ≈ $0.475（参考视频能力最好，价格可接受）
//   Kling 运镜（需要人物主体图，动作还原最强，放后面因为要抽帧/上传图）
//   wan3.0 / happyhorse（兜底）
export const MODEL_CHAIN = [wanR2V, minimax, klingMotion];

export const ADAPTERS = {
  [wanR2V.id]: wanR2V,
  [minimax.id]: minimax,
  [klingMotion.id]: klingMotion,
  [wan30.id]: wan30,
  [happyhorseR2V.id]: happyhorseR2V,
};

export function getAdapter(id) { return ADAPTERS[id] || null; }

// ---------- 端点是原生厂商格式还是统一格式 ----------
export function isNativeEndpoint(adapter) { return adapter.endpoint.startsWith("/kling/"); }

export { nearest, nearestSize, orientation, PT_BASE };
