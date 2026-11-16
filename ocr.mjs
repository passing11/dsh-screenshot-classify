import { readFileSync } from "node:fs";

const DEFAULT_PROMPT =
  "请识别图片中的全部文字内容,原样输出;数学公式用 LaTeX 输出。只输出识别结果,不要任何解释。";

/** 整条识别链的累计上限:超过就不再试后面的候选。 */
const CHAIN_DEADLINE_MS = 180000;
/** 单个候选的上限(还会被剩余预算再压一次)。 */
const ROUTE_TIMEOUT_MS = 120000;

/**
 * 图片文字识别(OCR)。
 *
 * 两种模式(config.ocr.mode):
 *   host → **宿主大模型**(DSH 0.1.7+ 的 llm + attachments 服务),零配置、不另要 key
 *   off  → 不识别
 *
 * host 模式按**模型槽位**依次尝试(主模型 → 备选 1 → 备选 2);
 * 三个槽位都留空时退回 0.3.x 的自动选路(hostModel → 宿主默认 → 目录里第一个带 image 的)。
 * 候选全部失败就抛错,并把每条原因写进错误里(笔记里能直接看到,不静默)。
 *
 * @param host - 宿主服务句柄 { llm, attachments, agentDefaultModel, logger },由插件注入的 getter 提供
 */
export async function ocrImage(config, imagePath, host = {}) {
  const mode = config.ocr?.mode ?? "host";
  if (mode === "off") return "";
  if (mode === "host") return ocrHostWithFallback(config, imagePath, host);
  throw new Error(`OCR: 未知模式 ${mode}`);
}

/**
 * "provider/model" 或裸 model id → { provider, model }。
 * 裸 id 用 defaultProvider 补齐;没有可用的默认 provider 就返回 null(该槽位不参与)。
 */
export function parseModelRef(raw, defaultProvider) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const at = s.indexOf("/");
  if (at > 0 && at < s.length - 1) return { provider: s.slice(0, at), model: s.slice(at + 1) };
  return defaultProvider ? { provider: defaultProvider, model: s } : null;
}

/**
 * 三个槽位 → 最多 3 个 { provider, model, label }。
 * 空槽位跳过;重复路由保留先出现的,后出现的忽略。
 */
export function resolveOcrChain(config, llm, host = {}) {
  const slots = [
    { value: config?.model?.primary, label: "主模型" },
    { value: config?.model?.fallback1, label: "备选 1" },
    { value: config?.model?.fallback2, label: "备选 2" },
  ];
  let defaultProvider = null;
  try {
    defaultProvider = host?.agentDefaultModel?.currentSelection?.()?.provider ?? null;
  } catch {
    defaultProvider = null;
  }
  if (!defaultProvider) {
    try {
      defaultProvider = (llm?.listProviders?.() ?? [])[0]?.id ?? null;
    } catch {
      defaultProvider = null;
    }
  }
  const out = [];
  const seen = new Set();
  for (const slot of slots) {
    const ref = parseModelRef(slot.value, defaultProvider);
    if (!ref) continue;
    const key = `${ref.provider}/${ref.model}`;
    if (seen.has(key)) continue; // 后出现的忽略
    seen.add(key);
    out.push({ ...ref, label: slot.label });
  }
  return out;
}

/** 把一次失败的调用归类成一个短标签(写进错误信息,方便一眼看出是哪种坏法)。 */
export function reasonOf(err) {
  const msg = String(err?.message ?? err);
  if (err?.name === "AbortError" || /超时|timed out|aborted/i.test(msg)) return "timeout";
  if (err?.code === "no-image-support" || /没有声明图片输入|不支持图片|no-image/i.test(msg)) return "no-image-support";
  if (err?.code === "empty-text" || /空文本|空响应/.test(msg)) return "empty-text";
  if (/模型返回错误|HTTP \d{3}|ECONN|ENOTFOUND|fetch failed/i.test(msg)) return "http-error";
  return "unknown";
}

/**
 * 读图 + 过附件服务换 ref。**整条链只做一次** —— 每换一个候选模型都重传一遍图
 * 是白白翻倍的上传与内存开销。
 */
async function prepareImage(config, imagePath, host) {
  const attachments = host.attachments;
  if (!attachments || typeof attachments.saveImage !== "function") {
    throw new Error("宿主 attachments 服务不可用(需要 dsh-attachment)");
  }

  const data = readFileSync(imagePath);
  const mediaType = data[0] === 0x89 && data[1] === 0x50 ? "image/png" : "image/jpeg";
  const limits = attachments.imageLimits;
  if (limits?.mediaTypes && !limits.mediaTypes.includes(mediaType)) {
    throw new Error(`宿主不接受 ${mediaType}`);
  }
  if (limits?.maxImageBytes && data.byteLength > limits.maxImageBytes) {
    throw new Error(`图片 ${(data.byteLength / 1048576).toFixed(1)}MB 超过宿主上限 ${(limits.maxImageBytes / 1048576).toFixed(1)}MB`);
  }

  const ref = await attachments.saveImage({
    data,
    mediaType,
    name: `screenshot.${mediaType === "image/png" ? "png" : "jpg"}`,
  });
  return { ref, mediaType, prompt: config.ocr?.prompt || DEFAULT_PROMPT };
}

/**
 * 用指定路由识别一次。
 *
 * 契约(0.1.7 实测):
 *  ① 图片必须走**附件服务**换 ImageAttachmentRef —— 消息里的 ImageBlock 只认 attachment,
 *     不能塞 base64 data URL;宿主会按模型的像素/字节预算自己重编码。
 *  ② 一次性调用用 `RequestUserInput`({role,content},不带 id/source)最省事。
 *  ③ `ctx.llm` 只有 stream(),没有 call();必须收 text-delta。
 *  ④ 是否支持图片看 **catalog 的 inputModalities**(不是模型真实能力),所以要预检。
 */
async function ocrViaRoute(route, prepared, llm, host) {
  // 能力预检:目录**明确说**不支持图片就直接跳过这个候选(换个模型比发一个必败请求便宜)。
  // 查不到(返回 null)时放行 —— 拿不到元数据就拒会把所有老适配器一起废掉。
  const support = await imageSupportOf(llm, route.provider, route.model);
  if (support === false) {
    const err = new Error(`模型 ${route.provider}/${route.model} 没有声明图片输入(inputModalities 不含 image)`);
    err.code = "no-image-support";
    throw err;
  }

  const message = {
    role: "user",
    content: [
      { type: "text", text: prepared.prompt },
      { type: "image", attachment: prepared.ref },
    ],
  };

  const timeoutMs = Math.max(1000, Number(route.timeoutMs) || ROUTE_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 识别只要结果,不要推理:推理会吃掉输出预算,把整批变成"解析为空"。
  // 但**不能无条件传**:DSH 的 resolveCallWithInfo() 在模型的 reasoning 元数据缺失时,
  // 只要看到 reasoningEffort 就抛 UNSUPPORTED_REASONING_EFFORT(实测
  // workbuddy-global/deepseek-v4.1-flash 就是这样,连请求都发不出去)。
  // 所以先问模型要能力,只传它自己公布的档位;它没有推理能力就整个省略。
  const effort = await pickReasoningEffort(llm, route);
  let out = "";
  try {
    out = await streamText(llm, {
      provider: route.provider,
      model: route.model,
      messages: [message],
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      maxTokens: 4000,
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`宿主模型调用超时(${Math.round(timeoutMs / 1000)}s)`);
    // 兜底:能力查询与真实 dispatch 之间若仍对不上(适配器 HMR、目录变化),
    // 去掉 effort 再试一次 —— 少一个控制项,好过整条识别失败。
    if (effort !== undefined && /UNSUPPORTED_REASONING_EFFORT/.test(String(err?.message ?? ""))) {
      host.logger?.warn?.(
        `dsh-screenshot-classify: ${route.provider}/${route.model} 拒绝 reasoningEffort=${effort},改为不指定后重试`,
      );
      out = await streamText(llm, {
        provider: route.provider,
        model: route.model,
        messages: [message],
        maxTokens: 4000,
        signal: controller.signal,
      });
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }

  const text = out.trim();
  if (!text) {
    const err = new Error("宿主模型返回空文本");
    err.code = "empty-text";
    throw err;
  }
  return text;
}

/**
 * host 模式的入口:按槽位链依次试,全失败才抛错。
 *
 * 三个槽位都留空时走 `resolveHostRoute()`(0.3.x 的老行为:hostModel → 宿主默认 →
 * 目录里第一个声明 image 的模型),单条,不带链 —— 老用户升级后行为不变。
 */
async function ocrHostWithFallback(config, imagePath, host) {
  const llm = host.llm;
  if (!llm || typeof llm.stream !== "function") {
    throw new Error("宿主 llm 服务不可用(需要 DSH 0.1.7+ 且该 profile 已加载 dsh-llm)");
  }
  const prepared = await prepareImage(config, imagePath, host); // 图片只 saveImage 一次
  const chain = resolveOcrChain(config, llm, host);

  if (chain.length === 0) {
    const route = await resolveHostRoute(config, llm, host); // 0.3.x 行为,单条
    return ocrViaRoute(route, prepared, llm, host);
  }

  const deadline = Date.now() + CHAIN_DEADLINE_MS;
  const failures = [];
  for (const route of chain) {
    const left = deadline - Date.now();
    if (left <= 0) {
      failures.push({ key: `${route.provider}/${route.model}`, label: route.label, reason: "timeout", detail: "整链累计超过 180s" });
      continue;
    }
    try {
      return await ocrViaRoute({ ...route, timeoutMs: Math.min(ROUTE_TIMEOUT_MS, left) }, prepared, llm, host);
    } catch (err) {
      const detail = String(err?.message ?? err);
      const reason = reasonOf(err);
      failures.push({ key: `${route.provider}/${route.model}`, label: route.label, reason, detail });
      host.logger?.warn?.(
        `dsh-screenshot-classify: OCR 候选 ${route.provider}/${route.model} 失败(${reason})—— ${detail}`,
      );
    }
  }
  throw new Error(
    `OCR 全部失败(试过 ${failures.length} 个模型):` +
      failures.map((f) => `${f.label} ${f.key} → ${f.reason}(${f.detail})`).join(" | "),
  );
}

/**
 * 收一次 stream,把 text-delta 拼成全文;`finish.reason.kind === "error"` 转成异常。
 * 抽出来是为了让"带 effort"和"不带 effort 重试"两条路共用同一段收流逻辑。
 */
export async function streamText(llm, options) {
  let out = "";
  for await (const chunk of llm.stream(options)) {
    if (chunk?.type === "text-delta" && typeof chunk.text === "string") out += chunk.text;
    if (chunk?.type === "finish" && chunk.reason?.kind === "error") {
      throw new Error(`模型返回错误 ${chunk.reason.failure?.code ?? "unknown"}: ${chunk.reason.failure?.message ?? ""}`);
    }
  }
  return out;
}

/**
 * 决定这次调用要不要带 reasoningEffort、带哪个。
 *
 * 规则(对齐 DSH 的 resolveCallWithInfo 校验,见 app.asar):
 *  - 模型**没有** reasoning 元数据 → 返回 undefined,**一个字段都不传**。
 *    传任何值都会被判 UNSUPPORTED_REASONING_EFFORT(这就是
 *    workbuddy-global/deepseek-v4.1-flash 上"识别失败"的直接原因)。
 *  - 有 reasoning.efforts → 优先 "off"(识别不需要思考,省输出预算);
 *    没有 off 就退而用它的 defaultEffort;再没有就不传(交给适配器默认)。
 *  - 查询失败(适配器未注册/目录抖动)→ undefined,不传,让请求自己决定。
 */
export async function pickReasoningEffort(llm, route) {
  if (typeof llm.resolveModelInfo !== "function") return undefined;
  let info;
  try {
    info = await llm.resolveModelInfo(route.provider, route.model);
  } catch {
    return undefined;
  }
  const reasoning = info?.reasoning;
  if (!reasoning) return undefined;
  const ids = (reasoning.efforts ?? []).map((e) => e?.id).filter(Boolean);
  if (ids.includes("off")) return "off";
  if (reasoning.defaultEffort && ids.includes(reasoning.defaultEffort)) return reasoning.defaultEffort;
  return undefined;
}

/**
 * 该模型是否声明了 image 模态。
 * 返回 true / false(=目录明确说没有)/ null(=查不到,调用方自己决定放不放行)。
 */
async function imageSupportOf(llm, provider, model) {
  if (typeof llm?.resolveModelInfo === "function") {
    try {
      const info = await llm.resolveModelInfo(provider, model);
      const declared = Array.isArray(info?.inputModalities) ? info.inputModalities : null;
      if (declared) return declared.includes("image");
    } catch {
      /* 元数据不可用,退回目录 */
    }
  }
  try {
    const models = await llm?.listModels?.(provider);
    const hit = (models ?? []).find((m) => m?.id === model);
    if (hit) {
      const declared = Array.isArray(hit.inputModalities) ? hit.inputModalities : null;
      if (declared) return declared.includes("image");
    }
  } catch {
    /* 目录不可用 → 未知 */
  }
  return null;
}

/**
 * 选宿主模型路由:先看显式配置的 hostModel,再看宿主默认模型,最后在目录里
 * 找第一个声明了 image 模态的。选不出来就抛错。
 */
async function resolveHostRoute(config, llm, host) {
  const want = String(config.ocr?.hostModel ?? "").trim();
  let sel = null;
  try {
    sel = host.agentDefaultModel?.currentSelection?.() ?? null;
  } catch {
    sel = null;
  }

  const candidates = [];
  if (want) {
    const provider = sel?.provider ?? (llm.listProviders?.()[0]?.id ?? undefined);
    candidates.push({ provider, model: want, why: "配置的 hostModel" });
  }
  if (sel?.provider && sel.model) candidates.push({ provider: sel.provider, model: sel.model, why: "宿主默认模型" });

  // 目录兜底:同一 provider 优先,其次任意 provider
  try {
    const providers = (llm.listProviders?.() ?? []).map((p) => p?.id ?? p).filter(Boolean);
    const ordered = sel?.provider ? [sel.provider, ...providers.filter((p) => p !== sel.provider)] : providers;
    for (const provider of ordered) {
      const models = await llm.listModels(provider);
      const hit = (models ?? []).find((m) => (m.inputModalities ?? []).includes("image"));
      if (hit) candidates.push({ provider: hit.provider ?? provider, model: hit.id, why: "目录中声明图片输入的模型" });
    }
  } catch {
    /* 目录不可用就不兜底,靠前面的候选 */
  }

  const seen = new Set();
  for (const cand of candidates) {
    if (!cand.provider || !cand.model) continue;
    const key = `${cand.provider}/${cand.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 查不到能力就放行(老适配器没有 inputModalities 元数据,拒了等于全废)
    if ((await imageSupportOf(llm, cand.provider, cand.model)) !== false) {
      host.logger?.info?.(`dsh-screenshot-classify: OCR 使用宿主模型 ${key}(${cand.why})`);
      return cand;
    }
  }

  const tried = [...seen].join(", ") || "（无候选）";
  throw new Error(
    `宿主没有声明图片输入的模型(试过 ${tried});` +
      `可在 DSH 设置里给模型加 inputModalities: [text, image],或在插件设置里指定模型槽位`,
  );
}
