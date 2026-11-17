import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { ClipboardWatcher } from "./clipboard.mjs";
import { DEFAULT_CONFIG, ensureVault, plain, resolveConfig } from "./config.mjs";
import { createSerialQueue, handleChoice } from "./core.mjs";
import { listEntriesForDate, organizeDay } from "./organize.mjs";
import { readDailyNote, todayString } from "./storage.mjs";

export const name = "dsh-screenshot-classify";
export const inject = ["tools"];

/**
 * 设置命名空间 = 本插件在 profile 里的**条目 id**(cordis.patch.yml 的 insert[].id),
 * 不是随便起的字符串。DSH 0.1.7 起设置服务按条目 id 投影 Config。
 *
 * 注意这里和原插件 `dsh-screenshot-capture` **故意不同**:两个插件都会注册一份
 * Config schema,用同一个 ns 会打架(后加载的把前者的投影覆盖掉)。
 * 但用户的既有配置必须能用,所以下面 LEGACY_SETTINGS_NS 会作为二次读取源。
 */
const SETTINGS_NS = "dsh-screenshot-classify";

/**
 * 原插件的命名空间。用户已经在那边配好了 vaultPath / OCR / 窗口位置,
 * 升级到这个插件时不该让他重填一遍 —— 所以自己的 ns 读不到值时,退回去读它。
 *
 * 这也解释了一个看似矛盾的要求:「配置要跟原插件区分」+「沿用原配置命名空间」。
 * 前者是**写**的目标(区分,避免投影冲突),后者是**读**的来源(沿用,装完即用)。
 */
const LEGACY_SETTINGS_NS = "dsh-screenshot-capture";

/**
 * 降级包装:schemastery < 3.18.4 没有 .volatile(),直接调用会抛
 * "volatile is not a function"(模块加载期就崩)。带上兜底更稳。
 */
const vol = (schema) => (typeof schema.volatile === "function" ? schema.volatile() : schema);

/**
 * 插件配置 schema。DSH 0.1.7 的设置服务**直接投影 loader 条目上的这个 Config**,
 * 不再需要插件事先 register 一份 schema+值(那是双份数据源)。
 *
 * 两条硬门禁:
 *  ① 必须是**纯具名导出**(`export const Config`),绝不能加 `export default` ——
 *     加载器剥壳后读的是 `plugin.Config`,一旦有 default 就会剥成那个函数,Config 丢失,
 *     设置页**静默消失**(describe() 里 `return []`,一个日志都不打)。
 *  ② 每个会被设置页写入的字段都要 `.volatile()` 盖章 —— 否则整个条目被
 *     volatileForm() 过滤掉;漏盖的单个字段在写入时抛 `Config field "x" is not volatile`。
 *
 * 结构保持扁平:客户端便捷方法 `set(field, value)` 只收单个一级字段名(path:[field])。
 * 嵌套 schema 本身是合法的(volatileForm / isVolatilePath 都递归),这里扁平只是
 * 为了配合 set() —— 所以 host 侧再做一层扁平 ↔ 嵌套的映射。
 */
export const Config = z.object({
  enabled: vol(z.boolean().default(true)),
  vaultPath: vol(z.string().default(DEFAULT_CONFIG.vaultPath)),
  pollIntervalMs: vol(z.number().min(50).max(60000).default(DEFAULT_CONFIG.pollIntervalMs)),
  cooldownMs: vol(z.number().min(0).max(120000).default(DEFAULT_CONFIG.cooldownMs)),
  ocrMode: vol(z.union([z.const("host"), z.const("off")]).default(DEFAULT_CONFIG.ocr.mode)),
  ocrHostModel: vol(z.string().default(DEFAULT_CONFIG.ocr.hostModel)),
  ocrPrompt: vol(z.string().default(DEFAULT_CONFIG.ocr.prompt)),
  // ---- 模型槽位(OCR 用) ----
  // 值写 "provider/model" 或裸 model id;留空 = 该槽位不参与。
  modelPrimary: vol(z.string().default(DEFAULT_CONFIG.model.primary)),
  modelFallback1: vol(z.string().default(DEFAULT_CONFIG.model.fallback1)),
  modelFallback2: vol(z.string().default(DEFAULT_CONFIG.model.fallback2)),
  dialogPositionMode: vol(z.union([z.const("cursor"), z.const("fixed"), z.const("remember")]).default(DEFAULT_CONFIG.dialog.positionMode)),
  dialogFixedX: vol(z.number().min(-20000).max(20000).default(DEFAULT_CONFIG.dialog.fixedX)),
  dialogFixedY: vol(z.number().min(-20000).max(20000).default(DEFAULT_CONFIG.dialog.fixedY)),
  dialogOffsetX: vol(z.number().min(-1000).max(1000).default(DEFAULT_CONFIG.dialog.offsetX)),
  dialogOffsetY: vol(z.number().min(-1000).max(1000).default(DEFAULT_CONFIG.dialog.offsetY)),
  dialogPreviewMaxWidth: vol(z.number().min(100).max(2000).default(DEFAULT_CONFIG.dialog.previewMaxWidth)),
  // 固定尺寸:0 = 不固定(按内容自适应)。
  dialogWidth: vol(z.number().min(0).max(4000).default(DEFAULT_CONFIG.dialog.width)),
  dialogHeight: vol(z.number().min(0).max(4000).default(DEFAULT_CONFIG.dialog.height)),
  // 悬浮窗自动关闭秒数。0 = 不自动关(默认),一直等用户点。
  dialogAutoCloseSec: vol(z.number().min(0).max(3600).default(DEFAULT_CONFIG.dialog.autoCloseSec)),
  // 悬浮窗配色主题。四套只换配色与头部图标画法,布局与操作完全一致。
  dialogTheme: vol(z.union([z.const("c1"), z.const("c2"), z.const("c3"), z.const("c4")]).default(DEFAULT_CONFIG.dialog.theme)),
  // ---- 分类 ----
  // 入库时按内容给截图打一个 #类目 标签。纯本地规则,不联网不花钱。
  classifyEnabled: vol(z.boolean().default(DEFAULT_CONFIG.classify.enabled)),
  // 低于这个置信度就在 OCR 行下面补一句「分类: …（弱）」。
  classifyMinConfidence: vol(z.number().min(0).max(1).default(DEFAULT_CONFIG.classify.minConfidence)),
  // ---- 摘要(只对 #文档 生效) ----
  summarizeMode: vol(z.union([z.const("off"), z.const("rules"), z.const("host")]).default(DEFAULT_CONFIG.summarize.mode)),
  summarizeHostModel: vol(z.string().default(DEFAULT_CONFIG.summarize.hostModel)),
  summarizeMaxChars: vol(z.number().min(20).max(500).default(DEFAULT_CONFIG.summarize.maxChars)),
});

const has = (flat, key) => Object.prototype.hasOwnProperty.call(flat, key) && flat[key] !== undefined;

/** 插件嵌套结构 → 扁平 settings 结构(与 fromFlat 互逆,用于输入归一化) */
function toFlat(config) {
  return {
    enabled: config.enabled,
    vaultPath: config.vaultPath,
    pollIntervalMs: config.pollIntervalMs,
    cooldownMs: config.cooldownMs,
    ocrMode: config.ocr?.mode,
    ocrHostModel: config.ocr?.hostModel ?? "",
    ocrPrompt: config.ocr?.prompt,
    modelPrimary: config.model?.primary ?? "",
    modelFallback1: config.model?.fallback1 ?? "",
    modelFallback2: config.model?.fallback2 ?? "",
    dialogPositionMode: config.dialog?.positionMode,
    dialogFixedX: config.dialog?.fixedX,
    dialogFixedY: config.dialog?.fixedY,
    dialogOffsetX: config.dialog?.offsetX,
    dialogOffsetY: config.dialog?.offsetY,
    dialogPreviewMaxWidth: config.dialog?.previewMaxWidth,
    dialogWidth: config.dialog?.width,
    dialogHeight: config.dialog?.height,
    dialogAutoCloseSec: config.dialog?.autoCloseSec,
    dialogTheme: config.dialog?.theme,
    classifyEnabled: config.classify?.enabled,
    classifyMinConfidence: config.classify?.minConfidence,
    summarizeMode: config.summarize?.mode,
    summarizeHostModel: config.summarize?.hostModel ?? "",
    summarizeMaxChars: config.summarize?.maxChars,
  };
}

/** schema 默认值(DEFAULT_CONFIG 与 Config 逐字段同源,拿它当"没配过"的判据) */
const DEFAULTS_FLAT = toFlat(DEFAULT_CONFIG);

/**
 * 把「可能嵌套、也可能扁平」的配置归一化成扁平结构。
 *
 * 宿主传进 `apply(ctx, input)` 的 input、以及 settings 投影出来的 `row.user`,
 * 都是**扁平**的 —— 键就是 Config schema 里那些名字(`dialogAutoCloseSec`)。
 * 而 `toFlat()` 要的是**嵌套**结构(`dialog.autoCloseSec`)。
 *
 * 早期版本两处都直接写了 `toFlat(input)` / `toFlat(row.user)`,于是每个字段都被
 * 读成 undefined,`dropDefaults()` 再把它们全过滤掉 —— 结果是 profile 条目里
 * 写的 `config: { dialogAutoCloseSec: 5 }` **永远进不了 watcher**(2026-10-29 定位)。
 * 当初没暴露,是因为 `config.json` 这一层用的是嵌套结构,恰好走对;patch 里的
 * 扁平 config 才是宿主真正的权威值。
 */
export function flattenConfig(value) {
  const flat = plain(value);
  if (flat === null || typeof flat !== "object" || Array.isArray(flat)) return {};
  const isNested = Object.values(flat).some(
    (item) => item !== null && typeof item === "object" && !Array.isArray(item),
  );
  return isNested ? toFlat(flat) : { ...flat };
}

/**
 * 丢掉"等于 schema 默认值"的字段。
 *
 * DSH 0.1.7 传进 apply 的 input 是**完整解析后的配置**(默认值全在),
 * 再也分不出"用户显式配了默认值"和"根本没配"。若无脑用它覆盖,
 * config.json 里配好的 vaultPath 会被默认空串冲掉 → 监听直接停摆。
 * 判据取 DEFAULT_CONFIG(与 Config 的 .default() 同源)。
 */
function dropDefaults(flat) {
  return Object.fromEntries(
    Object.entries(flat).filter(([key, value]) => value !== undefined && !Object.is(value, DEFAULTS_FLAT[key])),
  );
}

/**
 * 只挑「窗口该多大 / 出现在哪」这几个字段,供设置页与测试判断几何设置有没有变过。
 *
 * 0.4.6 里这个函数用来决定"要不要删掉位置记录" —— 那时记录无条件优先,设置页里
 * 填的坐标/尺寸永远被旧记录压住,只能靠删记录让新设置生效。
 * 0.4.8 起 remember 是**独立模式**,`fixed` / `cursor` 根本不读记录,两者不再冲突,
 * 删记录那套逻辑也一并去掉 —— 用户在别的模式下改偏移量,不该把记住的位置弄丢。
 * 现在它只被 test-settings-reload.mjs 用来钉住"哪些字段算几何字段"。
 */
function geometryKeyOf(cfg) {
  return JSON.stringify({
    mode: cfg.dialog?.positionMode,
    fixedX: cfg.dialog?.fixedX,
    fixedY: cfg.dialog?.fixedY,
    width: cfg.dialog?.width,
    height: cfg.dialog?.height,
  });
}

// 导出给测试用:钉住「等于默认值的字段会被丢掉」这个行为,以及它在
// settings/document-updated 路径上必须被关掉(否则改回默认值不生效)。
export { dropDefaults, fromFlat, geometryKeyOf, mergeSettings };

/**
 * settings 投影值 → 插件嵌套结构(只取真实存在的字段)。
 * 设置服务的 value 是**投影结果**,缺字段时返回 undefined;若无脑写进
 * liveConfig 会把已解析好的默认值冲掉,所以逐字段判存。
 */
function fromFlat(flat) {
  const out = {};
  const ocr = {};
  const model = {};
  const dialog = {};
  const classify = {};
  const summarize = {};
  if (has(flat, "enabled")) out.enabled = flat.enabled;
  if (has(flat, "vaultPath")) out.vaultPath = flat.vaultPath;
  if (has(flat, "pollIntervalMs")) out.pollIntervalMs = flat.pollIntervalMs;
  if (has(flat, "cooldownMs")) out.cooldownMs = flat.cooldownMs;
  if (has(flat, "ocrMode")) ocr.mode = flat.ocrMode;
  if (has(flat, "ocrHostModel")) ocr.hostModel = flat.ocrHostModel ?? "";
  if (has(flat, "ocrPrompt")) ocr.prompt = flat.ocrPrompt;
  if (has(flat, "modelPrimary")) model.primary = flat.modelPrimary ?? "";
  if (has(flat, "modelFallback1")) model.fallback1 = flat.modelFallback1 ?? "";
  if (has(flat, "modelFallback2")) model.fallback2 = flat.modelFallback2 ?? "";
  if (has(flat, "dialogPositionMode")) dialog.positionMode = flat.dialogPositionMode;
  if (has(flat, "dialogFixedX")) dialog.fixedX = flat.dialogFixedX;
  if (has(flat, "dialogFixedY")) dialog.fixedY = flat.dialogFixedY;
  if (has(flat, "dialogOffsetX")) dialog.offsetX = flat.dialogOffsetX;
  if (has(flat, "dialogOffsetY")) dialog.offsetY = flat.dialogOffsetY;
  if (has(flat, "dialogPreviewMaxWidth")) dialog.previewMaxWidth = flat.dialogPreviewMaxWidth;
  if (has(flat, "dialogWidth")) dialog.width = flat.dialogWidth;
  if (has(flat, "dialogHeight")) dialog.height = flat.dialogHeight;
  if (has(flat, "dialogAutoCloseSec")) dialog.autoCloseSec = flat.dialogAutoCloseSec;
  if (has(flat, "dialogTheme")) dialog.theme = flat.dialogTheme;
  if (has(flat, "classifyEnabled")) classify.enabled = flat.classifyEnabled;
  if (has(flat, "classifyMinConfidence")) classify.minConfidence = flat.classifyMinConfidence;
  if (has(flat, "summarizeMode")) summarize.mode = flat.summarizeMode;
  if (has(flat, "summarizeHostModel")) summarize.hostModel = flat.summarizeHostModel ?? "";
  if (has(flat, "summarizeMaxChars")) summarize.maxChars = flat.summarizeMaxChars;
  if (Object.keys(ocr).length > 0) out.ocr = ocr;
  if (Object.keys(model).length > 0) out.model = model;
  if (Object.keys(dialog).length > 0) out.dialog = dialog;
  if (Object.keys(classify).length > 0) out.classify = classify;
  if (Object.keys(summarize).length > 0) out.summarize = summarize;
  return out;
}

/** 把 settings 投影值深合并进 liveConfig(顶层浅合并 + 各子对象逐层合并) */
function mergeSettings(liveConfig, flat) {
  const patch = fromFlat(flat);
  return {
    ...liveConfig,
    ...patch,
    ocr: patch.ocr ? { ...liveConfig.ocr, ...patch.ocr } : liveConfig.ocr,
    model: patch.model ? { ...liveConfig.model, ...patch.model } : liveConfig.model,
    dialog: patch.dialog ? { ...liveConfig.dialog, ...patch.dialog } : liveConfig.dialog,
    classify: patch.classify ? { ...liveConfig.classify, ...patch.classify } : liveConfig.classify,
    summarize: patch.summarize ? { ...liveConfig.summarize, ...patch.summarize } : liveConfig.summarize,
  };
}

export function apply(ctx, input = {}) {
  // 初始配置:默认值 ← config.json ← 插件行显式 config。
  // ① input 先 plain() 解包 Volatile cell(0.1.7 每个 volatile 字段都是 cell);
  // ② 再 dropDefaults 丢掉"等于 schema 默认值"的字段 —— 否则宿主灌进来的
  //    默认值(尤其 vaultPath: "")会把 config.json 里配好的路径冲掉。
  let liveConfig = mergeSettings(resolveConfig(), dropDefaults(flattenConfig(input)));
  // vaultPath 为空时**不碰磁盘**:ensureVault 用的是 join(vaultPath, ...),
  // 空路径会解析成相对路径、在进程 cwd 下凭空建出「收件箱/知识库」等目录 ——
  // 正是上面那条告警承诺过不会发生的事。
  if (!liveConfig.vaultPath) {
    ctx.logger.warn("dsh-screenshot-classify: 未配置 vaultPath,采集功能已停用");
  } else {
    try {
      ensureVault(liveConfig);
    } catch (err) {
      ctx.logger.warn(`dsh-screenshot-classify: vault 初始化失败:${err.message}`);
    }
  }

  // ---- 剪贴板监听:单例 + 串行化重启 + 助手异常退出自动重试 ----
  // 全程只有一个 watcher。配置变化时先等旧 PowerShell 进程真正退出
  // (stopAsync:kill + taskkill 兜底 + 超时),再起新的;配置没变就不重启,
  // 避免残留多个监听导致一次截图弹多个窗。
  // 助手崩了要能自己回来:以前只打一条日志,任何一次异常退出都变成"静默失效"
  // (用户表现为「截图没弹窗」),所以这里带退避重试 + 明确告警。
  const MAX_RETRY = 5;
  let watcher = null;
  let watcherKey = null; // 当前 watcher 所用配置的特征串
  let disposed = false;
  let restartChain = Promise.resolve();
  let retryTimer = null;
  let retryCount = 0;
  // 另一个 DSH 实例正持有监听锁:本实例静默让位,不算故障、不重试。
  let busyLocked = false;
  let busyTimer = null;

  const configKey = (cfg) => JSON.stringify({
    enabled: cfg.enabled,
    vaultPath: cfg.vaultPath,
    pollIntervalMs: cfg.pollIntervalMs,
    cooldownMs: cfg.cooldownMs,
    // 悬浮窗的这几个参数由助手在**弹窗那一刻**读 watcher-config.json,
    // 但助手进程只在启动时读一次 —— 所以它们变了必须重启助手才生效,
    // 全部要进特征串(漏一个就表现为"改了设置没反应")。
    dialogPositionMode: cfg.dialog?.positionMode,
    dialogFixedX: cfg.dialog?.fixedX,
    dialogFixedY: cfg.dialog?.fixedY,
    dialogOffsetX: cfg.dialog?.offsetX,
    dialogOffsetY: cfg.dialog?.offsetY,
    dialogPreviewMaxWidth: cfg.dialog?.previewMaxWidth,
    dialogWidth: cfg.dialog?.width,
    dialogHeight: cfg.dialog?.height,
    dialogAutoCloseSec: cfg.dialog?.autoCloseSec,
    // 主题也是助手启动时读一次的,换主题同样要重启助手才看得到。
    dialogTheme: cfg.dialog?.theme,
  });

  // ---- 宿主服务句柄(OCR 走宿主大模型用) ----
  // 用 getter 惰性取:服务可能比本插件晚注册,而且**不硬依赖** ——
  // 老版本 DSH / 精简 profile 里没有 llm 或 attachments 时,插件照常跑,
  // 只是没有可用的 OCR 候选,不会因为缺服务整个不激活。
  const host = {
    get llm() { return ctx.get("llm"); },
    get attachments() { return ctx.get("attachments"); },
    get agentDefaultModel() { return ctx.get("agentDefaultModel"); },
    logger: ctx.logger,
  };

  const startWatcher = (cfg) => {
    const w = new ClipboardWatcher(cfg);
    // 连拍两张时两次 handleChoice 会并发,而它内部是「读笔记 → 改 → 写回」→ 会互相覆盖;
    // 统一进串行队列(每次点击一个接一个走,OCR 慢也排队,不再丢文字)。
    const enqueueChoice = createSerialQueue();
    w.on("choice", ({ action, path, note = "", isKey = false, category = "" }) => {
      enqueueChoice(async () => {
        try {
          // 用**当前**的 liveConfig,不是启 watcher 时的快照。
          // 分类开关 / 摘要模式不在 configKey 里(它们不影响 watcher 进程),
          // 所以改完设置不会重启监听助手 —— 若这里用快照,用户会看到
          // 「改了开关没反应」,直到下次重启插件。
          const current = liveConfig;
          const result = await handleChoice(current, { action, path, note, isKey, category }, host);
          ctx.logger.info(`dsh-screenshot-classify: ${result.note} (${action})`);
        } catch (err) {
          ctx.logger.warn(`dsh-screenshot-classify: 处理失败:${err.message}`);
        }
      });
    });
    w.on("err", (ev) => ctx.logger.warn(`dsh-screenshot-classify: ${ev.msg}`));
    // 抢锁失败:另一个 DSH 实例已经在听剪贴板了。此时**不**重试 ——
    // 重试只会和对方抢,反而可能两边都弹。让它听着,等它退出后本实例
    // 靠配置变化或重启来接管。
    w.on("busy", (ev) => {
      busyLocked = true;
      ctx.logger.warn(`dsh-screenshot-classify: ${ev.msg}`);
      scheduleBusyRecheck();
    });
    w.on("ready", () => {
      busyLocked = false;
      if (retryCount > 0) ctx.logger.info(`dsh-screenshot-classify: 监听助手第 ${retryCount} 次重试后已就绪`);
      retryCount = 0;
    });
    w.on("exit", (ev) => {
      ctx.logger.warn(`dsh-screenshot-classify: 监听助手退出 code=${ev.code}`);
      // watcher !== w 说明这是配置变化/卸载时的**预期内**停止,不重试
      if (disposed || watcher !== w) return;
      watcher = null;
      watcherKey = null;
      scheduleRetry();
    });
    watcher = w;
    w.start();
  };

  const scheduleRetry = () => {
    if (disposed || retryTimer) return;
    const cfg = liveConfig;
    if (!cfg.enabled || !cfg.vaultPath) return;
    if (retryCount >= MAX_RETRY) {
      ctx.logger.warn(
        `dsh-screenshot-classify: 监听助手连续 ${MAX_RETRY} 次异常退出,已停止自动重启 —— 请检查 vaultPath 与 scripts/clip-dialog.ps1`,
      );
      return;
    }
    retryCount += 1;
    const delay = Math.min(30000, 2000 * 2 ** (retryCount - 1));
    ctx.logger.warn(`dsh-screenshot-classify: ${delay}ms 后自动重启监听助手(第 ${retryCount}/${MAX_RETRY} 次)`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      restartChain = restartChain.then(async () => {
        if (disposed) return;
        const cur = liveConfig;
        if (!cur.enabled || !cur.vaultPath) return;
        watcherKey = configKey(cur);
        startWatcher(cur);
      });
    }, delay);
    retryTimer.unref?.();
  };

  /**
   * 锁被别的实例占着时,每 15s 探一次:对方退出后本实例自动接管。
   * 不用重试退避那一套 —— 这不算故障,只是等一个先来后到。
   */
  const scheduleBusyRecheck = () => {
    if (disposed || busyTimer) return;
    busyTimer = setInterval(() => {
      if (disposed) return;
      if (!busyLocked) { clearInterval(busyTimer); busyTimer = null; return; }
      const cfg = liveConfig;
      if (!cfg.enabled || !cfg.vaultPath) return;
      restartChain = restartChain.then(async () => {
        if (disposed || !busyLocked) return;
        busyLocked = false;
        watcherKey = null; // 逼它真的重起,别被特征串短路
        startWatcher(cfg);
      });
    }, 15000);
    busyTimer.unref?.();
  };

  const scheduleRestart = () => {
    const cfg = liveConfig;
    const key = configKey(cfg);
    restartChain = restartChain.then(async () => {
      if (disposed || key === watcherKey) return;
      watcherKey = key;
      const old = watcher;
      if (old) {
        watcher = null;
        await old.stopAsync();
      }
      if (!cfg.enabled || !cfg.vaultPath) return;
      retryCount = 0;
      startWatcher(cfg);
    });
  };

  const disposeWatcher = () => {
    disposed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (busyTimer) {
      clearInterval(busyTimer);
      busyTimer = null;
    }
    if (watcher) {
      watcher.stop();
      watcher = null;
    }
  };

  ctx.effect(
    () => {
      scheduleRestart();
      return disposeWatcher;
    },
    "dsh-screenshot-classify.watcher",
  );

  // 设置服务(DSH 0.1.7+):只读回**用户显式配置过**的字段做兜底。**不再自己 register** ——
  // 新契约下权威值就是本插件在 profile 条目上的 Config。
  // 关键:必须用 row.user,不能用 row.value / row.base —— 后两者是"投影结果",
  // schema 默认值也在里面(实测 vaultPath 恒为 "")。拿它覆盖 liveConfig 会把
  // config.json 里配好的 vaultPath 冲成空串 → scheduleRestart 直接 return,
  // 刚起来的监听助手还会被 stopAsync 杀掉 → 截图永远不弹窗(2026-09-29 定位的故障 B)。
  //
  // 2026-11-01:原先这里**只在插件加载时读一次**,没有任何变更订阅 —— 于是用户在
  // 设置页改完(写成功了、yml 也变了)插件毫不知情,watcher 永远按旧配置跑。
  // 用户看到的就是「改了设置没反应 / 固定位置不生效」。现在补上
  // `settings/document-updated` 订阅(宿主 emit,签名 (ns, revision)),
  // 每次写完都重新拉一遍 user 覆盖层再比对特征串决定要不要重启助手。
  // `row.user` 是**用户显式写进 patch 的覆盖层**,本身就不含 schema 默认值;
  // 首次加载再套一层 dropDefaults 是历史保守做法(防老版本宿主把默认值灌进来)。
  // 但**变更更新时不能 drop**:用户把「出现位置」从 fixed 改回 cursor 时,
  // cursor 恰好等于 schema 默认值,被 drop 掉就等于"这次改动被忽略",
  // liveConfig 永远停在 fixed —— 正是「切不回跟随鼠标」的成因。
  const pullSettings = (settings, { dropSchemaDefaults }) => {
    // 兼容旧版 DSH:没有 describe 就退回纯 JSON 配置,不报错。
    if (!settings || typeof settings.describe !== "function") return;
    const rows = settings.describe();

    // 自己那一份优先(用户在新插件设置页里改的)。
    const own = rows.find((r) => r.ns === SETTINGS_NS);
    const ownFlat = own ? flattenConfig(own.user) : {};

    // 自己没配的字段,回头读原插件的覆盖层 —— 用户不会愿意为了升级
    // 把 vaultPath / OCR / 窗口位置重填一遍。**逐字段**兜底,不是整份覆盖:
    // 新插件里显式改过的字段必须赢。
    const legacy = rows.find((r) => r.ns === LEGACY_SETTINGS_NS);
    const legacyFlat = legacy ? flattenConfig(legacy.user) : {};
    const merged = { ...legacyFlat, ...ownFlat };

    const explicit = dropSchemaDefaults ? dropDefaults(merged) : merged;
    if (Object.keys(explicit).length === 0) return;
    liveConfig = mergeSettings(liveConfig, explicit);
    scheduleRestart();
  };

  ctx.inject(["settings"], (settingsCtx) => {
    try {
      const settings = settingsCtx.settings;
      pullSettings(settings, { dropSchemaDefaults: true });
      // 订阅变更:本插件的命名空间变了要重读;原插件的命名空间也订 ——
      // 用户可能还在旧设置页里改东西(两个插件并存的那段时间)。
      settingsCtx.on("settings/document-updated", (ns) => {
        if (ns !== SETTINGS_NS && ns !== LEGACY_SETTINGS_NS) return;
        try {
          pullSettings(settings, { dropSchemaDefaults: false });
        } catch (err) {
          ctx.logger.warn(`dsh-screenshot-classify: 应用新设置失败:${err.message}`);
        }
      });
    } catch (err) {
      ctx.logger.warn(`dsh-screenshot-classify: 读取设置失败,使用 JSON 配置:${err.message}`);
    }
  });

  // ---- 只读端点:模型目录 + 连通性探针(设置页用) ----
  // 写法照 dsh-tes-config/index.mjs:686 —— ctx.inject 回调里直接用传进来的 webCtx
  // 建 effect,回调返回值交给框架收。**不要在外面套 try/catch**:套了以后 effect
  // 失败会被吞掉,插件照旧以 failed 收场,只是原因看不见。
  // webServer 不进 export const inject,靠这里惰性注入 —— profile 没装 web 服务时
  // 这段整块不执行,插件其余功能照常。
  ctx.inject(["webServer"], (webCtx) => {
    const json = (res, status, payload) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(payload));
    };

    /**
     * 模型目录:provider → models[{ id, name, supportsImage, imageUnknown, efforts, defaultEffort }]。
     *
     * `supportsImage` 只认目录**明确声明**的 inputModalities。查不到元数据时
     * `imageUnknown: true`、`supportsImage: false` —— 不谎称支持,但设置页仍允许选,
     * 由用户在「图片能力未知」的提示下自己决定(拒选会把所有老适配器一起挡掉)。
     */
    const catalog = async () => {
      try {
        const llm = host.llm;
        if (!llm || typeof llm.listProviders !== "function" || typeof llm.listModels !== "function") {
          return { providers: [], error: "宿主没有 llm 服务" };
        }
        const providers = [];
        for (const info of llm.listProviders() ?? []) {
          try {
            const models = [];
            for (const m of (await llm.listModels(info.id)) ?? []) {
              if (typeof m?.id !== "string") continue;
              let meta = null;
              if (typeof llm.resolveModelInfo === "function") {
                try {
                  meta = await llm.resolveModelInfo(info.id, m.id);
                } catch {
                  meta = null;
                }
              }
              const declared = Array.isArray(meta?.inputModalities)
                ? meta.inputModalities
                : Array.isArray(m.inputModalities)
                  ? m.inputModalities
                  : null;
              const entry = {
                id: m.id,
                name: typeof m.name === "string" && m.name ? m.name : m.id,
                supportsImage: declared ? declared.includes("image") : false,
                imageUnknown: !declared,
                efforts: [],
                defaultEffort: null,
              };
              const efforts = meta?.reasoning?.efforts;
              if (Array.isArray(efforts)) {
                entry.efforts = efforts
                  .filter((e) => e && typeof e.id === "string")
                  .map((e) => ({ id: e.id, name: typeof e.name === "string" && e.name ? e.name : e.id }));
                if (typeof meta.reasoning.defaultEffort === "string") entry.defaultEffort = meta.reasoning.defaultEffort;
              }
              models.push(entry);
            }
            providers.push({
              id: info.id,
              name: typeof info.name === "string" && info.name ? info.name : info.id,
              models,
            });
          } catch {
            /* 单个 provider 失败不影响整份目录 */
          }
        }
        return { providers };
      } catch (err) {
        // 服务异常不许变成 500:设置页拿这份数据是为了渲染选项,给了 error 就能降级
        return { providers: [], error: String(err?.message ?? err) };
      }
    };

    /**
     * 连通性探针:一次点击 = 一次最小请求(maxTokens 8、不带图、不带 reasoningEffort、不重试)。
     * 15s 上限;出错也回 200,由前端按 ok/error 显示。
     */
    const probe = async (provider, model) => {
      if (!provider || !model) return { ok: false, ms: 0, error: "缺少 provider 或 model 参数" };
      const llm = host.llm;
      if (!llm || typeof llm.stream !== "function") return { ok: false, ms: 0, error: "宿主没有 llm 服务" };
      const started = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15000);
      timer.unref?.();
      try {
        let finish;
        for await (const chunk of llm.stream({
          provider,
          model,
          messages: [{ role: "user", content: [{ type: "text", text: "在吗" }] }],
          maxTokens: 8,
          signal: ac.signal,
        })) {
          // 分片字段是 chunk.text —— 写成 chunk.delta 会永远读到 undefined
          if (chunk?.type === "finish") {
            finish = chunk.reason;
            break;
          }
        }
        const ms = Date.now() - started;
        const kind = finish?.kind ?? "stop";
        if (kind === "error" || kind === "aborted") {
          return { ok: false, ms, error: String(finish?.failure?.message ?? finish?.failure?.code ?? kind) };
        }
        return { ok: true, ms };
      } catch (err) {
        return { ok: false, ms: Date.now() - started, error: String(err?.message ?? err) };
      } finally {
        clearTimeout(timer);
      }
    };

    /**
     * 「刷新模型列表」要真的去问上游,不是把手上这份再念一遍。
     *
     * 目录是各 provider 插件在**启动时**拉下来缓存的,所以宿主里装了新适配器、
     * 或上游那边下架/改名/新增了模型,我们这边 `listModels()` 仍然念旧表 ——
     * 设置页不重开就永远看不到。唯一能让它变新的办法是调那个 provider 插件
     * 自己的 `models/refresh` 路由,让它去上游重拉并写回自己的设置。
     *
     * 抄 dsh-tes-config/index.mjs 的做法(它踩过这些坑):
     *  · 目标表写死插件名与路径 —— 这些是各 provider 插件的公开路由,不是内部实现;
     *  · 必须绝对 URL,宿主侧 fetch 是 Node 的,相对路径报 "Failed to parse URL";
     *  · 限并发 2。全铺开等于同时向同一家上游打一串请求,撞上它的并发限流后
     *    结论会变成「一堆失败」,而那是我自己压出来的假象;
     *  · 单个 provider 失败不影响其它,结果逐条回给前端。
     */
    const REFRESH_TARGETS = [
      {
        plugin: "dsh-connect-workbuddy",
        path: "/plugins/dsh-connect-workbuddy/models/refresh",
        regions: ["cn", "global"],
        providers: { cn: "workbuddy", global: "workbuddy-global" },
      },
      {
        plugin: "dsh-connect-trae",
        path: "/plugins/dsh-connect-trae/models/refresh",
        regions: ["cn", "ai"],
        providers: { cn: "trae", ai: "trae-global" },
      },
    ];

    /** 单次刷新请求的超时。上游拉目录通常一两秒,30 秒是「这家不通」的判定线。 */
    const REFRESH_TIMEOUT_MS = 30000;

    /** 本站 origin。宿主侧 fetch 不认相对路径,调别的插件的路由必须拼绝对地址。 */
    const originOf = (req) => {
      try {
        const ws = webCtx.webServer;
        if (ws && typeof ws.getOrigin === "function") {
          const o = ws.getOrigin();
          if (typeof o === "string" && o.length > 0) return o.replace(/\/+$/, "");
        }
      } catch {
        /* 拿不到就退回 Host 头 */
      }
      const hostHeader = req?.headers?.host;
      if (!hostHeader) return null;
      const proto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
      return `${proto}://${hostHeader}`;
    };

    /** 限并发地跑一组 promise;顺序与输入一致。 */
    const mapLimit = async (items, limit, run) => {
      const out = new Array(items.length);
      let next = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          out[i] = await run(items[i], i);
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
      return out;
    };

    /** 让一个 provider 插件去上游重拉它的模型表。失败也返回结果对象,不抛。 */
    const refreshOne = async (target, region, base) => {
      const provider = target.providers[region];
      if (!base) {
        return { plugin: target.plugin, region, provider, status: "fail", ms: 0, reason: "拿不到本站 origin" };
      }
      const url = `${base}${target.path}?region=${encodeURIComponent(region)}`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), REFRESH_TIMEOUT_MS);
      timer.unref?.();
      const started = Date.now();
      try {
        const resp = await fetch(url, { method: "POST", headers: { accept: "application/json" }, signal: ac.signal });
        const ms = Date.now() - started;
        const text = await resp.text();
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }
        if (!resp.ok) {
          return {
            plugin: target.plugin,
            region,
            provider,
            status: "fail",
            ms,
            reason: (body && (body.error || body.message)) || `HTTP ${resp.status}`,
          };
        }
        const models = Array.isArray(body?.models) ? body.models : [];
        return {
          plugin: target.plugin,
          region,
          provider,
          status: models.length > 0 ? "ok" : "empty",
          ms,
          count: models.length,
          reason: models.length === 0 ? "上游返回了 0 个模型" : undefined,
        };
      } catch (err) {
        const aborted = err?.name === "AbortError";
        return {
          plugin: target.plugin,
          region,
          provider,
          status: "fail",
          ms: Date.now() - started,
          reason: aborted ? `超过 ${REFRESH_TIMEOUT_MS / 1000} 秒没有响应` : String(err?.message ?? err),
        };
      } finally {
        clearTimeout(timer);
      }
    };

    /**
     * 刷新全部目标,然后**重新读一遍目录**回给前端。
     *
     * 顺序是刻意的:先让各 provider 去上游重拉(它们会写回自己的设置),
     * 再调 catalog() —— 那时 listModels() 才是新表。反过来做等于把旧表
     * 再念一遍,用户点了刷新却什么都没变,还以为按钮坏了。
     */
    const refreshAll = async (base) => {
      const jobs = [];
      for (const target of REFRESH_TARGETS) {
        for (const region of target.regions) jobs.push({ target, region });
      }
      const results = await mapLimit(jobs, 2, (j) => refreshOne(j.target, j.region, base));
      const fresh = await catalog();
      return {
        ...fresh,
        refresh: {
          at: new Date().toISOString(),
          results,
          summary: {
            total: results.length,
            ok: results.filter((r) => r.status === "ok").length,
            empty: results.filter((r) => r.status === "empty").length,
            fail: results.filter((r) => r.status === "fail").length,
          },
        },
      };
    };

    // 三条路由各自显式 register(不抽 helper):路径字面量与 kind:"exact" 同行,
    // 静态检查能直接看出注册了几个端点。
    const disposeModels = webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: "exact",
        path: "/plugins/dsh-screenshot-classify/models",
        handler: async (req, res) => {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          json(res, 200, await catalog());
        },
      });
      return () => dispose();
    }, `[${name}] /plugins/dsh-screenshot-classify/models`);

    const disposeProbe = webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: "exact",
        path: "/plugins/dsh-screenshot-classify/probe",
        handler: async (req, res) => {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          const q = new URL(req.url ?? "", "http://localhost").searchParams;
          json(res, 200, await probe((q.get("provider") ?? "").trim(), (q.get("model") ?? "").trim()));
        },
      });
      return () => dispose();
    }, `[${name}] /plugins/dsh-screenshot-classify/probe`);

    const disposeRefresh = webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: "exact",
        path: "/plugins/dsh-screenshot-classify/refresh",
        handler: async (req, res) => {
          // POST 而不是 GET:这个端点有副作用(会推动各 provider 去上游重拉并写回
          // 自己的设置),不该被浏览器预取或缓存的 GET 顺手触发。
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          try {
            json(res, 200, await refreshAll(originOf(req)));
          } catch (err) {
            json(res, 200, { providers: [], error: String(err?.message ?? err) });
          }
        },
      });
      return () => dispose();
    }, `[${name}] /plugins/dsh-screenshot-classify/refresh`);

    return () => {
      disposeModels();
      disposeProbe();
      disposeRefresh();
    };
  });

  // 工具
  ctx.tools.register(textTool({
    name: "screenshot_status",
    description:
      "查询「截图分类」插件的状态:监听是否开启、vault 路径、今天的已收条目数。",
    parameters: {},
    async execute() {
      const today = todayString();
      const note = readDailyNote(liveConfig, today);
      const count = (note.match(/^## /gm) || []).length;
      return [
        `监听:${watcher?.started ? "运行中" : "未运行"}`,
        `vault:${liveConfig.vaultPath}`,
        `OCR:${liveConfig.ocr?.mode ?? "off"}`,
        `今日条目:${count}`,
      ].join("\n");
    },
  }));

  ctx.tools.register(textTool({
    name: "screenshot_inbox_list",
    description:
      "列出某天「收件箱」里的全部截图条目(时间/类型/OCR文字)。晚间整理前调用,展示给用户选择保留哪些。",
    parameters: {
      date: { type: "string", description: "日期 YYYY-MM-DD,缺省今天" },
    },
    async execute(args) {
      const date = args.date || todayString();
      const entries = listEntriesForDate(liveConfig, date);
      if (entries.length === 0) return `${date} 收件箱为空(还没有截图)`;
      return entries
        .map((e, i) => {
          const lines = [`${i + 1}. [${e.time}] #${e.kind} ${e.imageRel ?? ""}`];
          if (e.isKey) lines.push(`   重点:是`);
          if (e.note) lines.push(`   注释:${e.note}`);
          lines.push(`   OCR:${(e.ocrText || "无").slice(0, 120)}`);
          return lines.join("\n");
        })
        .join("\n");
    },
  }));

  ctx.tools.register(textTool({
    name: "screenshot_inbox_organize",
    description:
      "晚间整理:对某天收件箱里【保留】的条目,按分类写入知识库并生成笔记、更新分类索引、写当日总结、加双链,然后把当天收件箱笔记移入归档。keep 传 'all' 表示全部保留。",
    parameters: {
      date: { type: "string", description: "日期 YYYY-MM-DD,缺省今天" },
      keep: {
        type: "array",
        items: { type: "string" },
        description: "保留条目的时间列表(如 ['14:30','15:02']),或 ['all'] 表示全部保留",
      },
      categories: {
        type: "object",
        additionalProperties: true,
        description: "可选:时间→分类名 的映射(如 {'14:30':'数学'}),缺省归入『未分类』",
      },
      summaryTitle: { type: "string", description: "可选:当日总结标题" },
    },
    async execute(args) {
      const date = args.date || todayString();
      const keepRaw = Array.isArray(args.keep) ? args.keep : ["all"];
      const keep = keepRaw.includes("all") ? null : keepRaw;
      const result = organizeDay(liveConfig, {
        date,
        keep,
        categories: args.categories ?? {},
        summaryTitle: args.summaryTitle ?? "",
      });
      return [
        `日期:${result.date}`,
        `保留:${result.keptCount} 条,丢弃:${result.discardedCount} 条`,
        `分类:${JSON.stringify(result.categories)}`,
        `总结:${result.summaryPath}`,
        `归档:${result.archived ?? "无"}`,
        `生成笔记:`,
        ...result.files.map((f) => `  ${f}`),
      ].join("\n");
    },
  }));
}

function textTool(definition) {
  return defineTool({
    ...definition,
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    presentCall: (args) => ({
      card: "generic",
      // ToolCallKind(DSH 0.2)只认 read/edit/delete/move/search/execute/fetch/other;
      // 旧写法 "text" 不在枚举里,只是不参与分类,这里对齐成 read(只读查询类工具)。
      kind: "read",
      title: definition.name,
      rawInput: args,
    }),
  });
}
