import { appendFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KIND, appendEntry, saveAttachment, stampParts, updateEntry } from "./storage.mjs";
import { ocrImage } from "./ocr.mjs";
import { classifyScreenshot, isValidCategory } from "./classify.mjs";
import { summarizeOcr } from "./summarize.mjs";

const PENDING_OCR_LOG = join(tmpdir(), "dsh-capture", "pending-ocr.jsonl");

/**
 * 从文件名/路径猜来源。截图入库时文件名是 `20261113_143000_文档.png`,
 * 里面没有包名也没有原始目录,所以这里基本只能给出 `screenshot`;
 * 保留包名识别是为了兼容「用户直接把手机里的原始截图拖进来」的路径。
 */
function guessSource(path, name) {
  const hay = `${path || ""} ${name || ""}`.toLowerCase();
  const pkg = String(name || "").match(
    /(com\.[a-z0-9_.]+|[a-z]+\.[a-z0-9]+\.[a-z0-9_.]+)\.(png|jpe?g|webp)$/i,
  )?.[1];
  if (/(mmexport|wx_camera|microMsg)/i.test(hay)) return { kind: "wechat", dirHint: "", pkg: pkg || "" };
  if (/^img_\d{8}_\d{6}/i.test(String(name || "")) || /camera/i.test(hay)) {
    return { kind: "camera", dirHint: "", pkg: pkg || "" };
  }
  if (/(screenshot|屏幕截图|scr_)/i.test(hay)) return { kind: "screenshot", dirHint: "", pkg: pkg || "" };
  return { kind: "screenshot", dirHint: "", pkg: pkg || "" };
}

/**
 * 串行队列:两次 handleChoice 并发会各自「读笔记 → 追加 → 写回」,
 * 后写的那次把前一次的条目覆盖掉。所有写入口必须排成一队。
 */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

function safeUnlink(path) {
  try {
    if (path) unlinkSync(path);
  } catch {
    /* 临时文件删不掉不是错误 */
  }
}

/**
 * 判定这张截图的类目。
 *
 * `manual` 来自弹窗下拉:用户选了具体类目就用它,选「自动」则 manual 为空,
 * 走规则判定。命中白名单之外的值一律当「自动」处理 —— 弹窗是 PowerShell
 * 传过来的字符串,不能信任。
 */
function decideCategory(config, { manual, filePath, width, height, text, source }) {
  if (!config?.classify?.enabled) return { category: "", weak: false, result: null };
  const usableManual = manual && isValidCategory(manual) ? manual : "";
  const result = classifyScreenshot({
    filePath,
    width,
    height,
    text,
    source,
    manual: usableManual,
  });
  const threshold = Number(config?.classify?.minConfidence ?? 0.55);
  // 「弱」= 证据只够猜,或者规则根本没命中。人工指定永远不算弱。
  const weak = result.evidence === 'manual' ? false : result.confidence < threshold || result.evidence === 'weak' || result.evidence === 'fallback';
  return { category: result.category, weak, result };
}

/**
 * 处理一次弹窗选择。这是**唯一**的写库入口。
 *
 * 两条路:
 *   #图片(img)  —— 不 OCR。没文字可判,类目靠形态学/包名,判完一次写完。
 *   #文档(doc)  —— 先占位写入(绝不让用户的截图丢失),再 OCR,
 *                  拿到文字后**才**判类目(文字是最强的信号),然后回填
 *                  OCR 文字 + 类目 + 摘要三样。
 */
export async function handleChoice(config, { action, path, note = "", isKey = false, category = "" } = {}, host = {}) {
  const { date, fileStamp, time } = stampParts();

  if (action === "ignore" || action === "copy") {
    safeUnlink(path);
    return { action: "ignore", date, time, note: "已忽略(剪贴板原样保留,可直接粘贴)" };
  }

  const kind = action === "doc" ? KIND.DOC : KIND.IMG;
  const imageRel = saveAttachment(config, path, date, fileStamp, kind);

  // 来源线索:截图刚落地,文件名里没有包名,基本只能判出 `screenshot`。
  // 保留这层是为了兼容「直接拖入手机原始截图」的路径 —— 那种文件名带包名。
  let source = guessSource(path, String(imageRel).split("/").pop() || "");

  if (kind === KIND.IMG) {
    // 没有 OCR 文字。判类目只用形态学与包名,判不准也没关系 ——
    // 证据弱会在标题行下面挂一行「分类: …（弱）」,用户晚间整理时能改。
    let decided = { category: "", weak: false, result: null };
    try {
      decided = decideCategory(config, { manual: category, filePath: path, width: 0, height: 0, text: "", source });
    } catch (err) {
      host?.logger?.warn?.(`dsh-screenshot-classify: 图片分类失败(${err?.message || err})`);
    }
    safeUnlink(path);
    const notePath = appendEntry(config, {
      date,
      time,
      kind,
      imageRel,
      category: decided.category,
      weak: decided.weak,
      note,
      isKey,
    });
    const tag = decided.category ? ` #${decided.category}` : "";
    return {
      action,
      date,
      time,
      imageRel,
      notePath,
      category: decided.category || null,
      confidence: decided.result?.confidence ?? null,
      evidence: decided.result?.evidence ?? null,
      note: `已存图片:${imageRel}${tag}`,
    };
  }

  // ---- #文档 ----
  // 先占位写入。OCR 可能要十几秒,这期间用户的截图已经安全落库。
  appendEntry(config, { date, time, kind, imageRel, ocrText: null, note, isKey });

  let ocrText = "";
  let ocrError = null;
  try {
    ocrText = await ocrImage(config, path, host);
  } catch (err) {
    ocrError = err?.message ? String(err.message) : String(err);
    host?.logger?.warn?.(`dsh-screenshot-classify: OCR 失败(${ocrError})`);
  } finally {
    safeUnlink(path);
  }

  const text = ocrError ? "" : ocrText;

  // 拿到文字之后才判类目 —— #文档 最强、最诚实的信号就是它自己写了什么。
  let decided = { category: "", weak: false, result: null };
  try {
    decided = decideCategory(config, { manual: category, filePath: path, width: 0, height: 0, text, source });
  } catch (err) {
    host?.logger?.warn?.(`dsh-screenshot-classify: 文档分类失败(${err?.message || err})`);
  }

  // 摘要只对文档做。识别失败时没有内容可总结,跳过。
  let summary = "";
  let summaryVia = null;
  if (!ocrError && text.trim()) {
    try {
      const s = await summarizeOcr(config, text, host);
      summary = s.summary || "";
      summaryVia = s.via;
    } catch (err) {
      host?.logger?.warn?.(`dsh-screenshot-classify: 摘要失败(${err?.message || err})`);
    }
  }

  const payload = {
    date,
    time,
    imageRel,
    ocrText: ocrError ? `（识别失败:${ocrError}）` : text,
    category: decided.category,
    weak: decided.weak,
    summary,
  };
  const written = await writeBackWithRetry(config, payload, host);

  const tag = decided.category ? ` #${decided.category}` : "";
  const tail = summary ? `；摘要:${summary}` : "";
  return {
    action,
    date,
    time,
    imageRel,
    notePath: written.path || null,
    ocrText: ocrText || null,
    ocrError,
    ocrWritten: written.ok,
    category: decided.category || null,
    confidence: decided.result?.confidence ?? null,
    evidence: decided.result?.evidence ?? null,
    summary: summary || null,
    summaryVia,
    note: ocrError
      ? `已存文档,但识别失败:${ocrError}${tag}`
      : `已存文档${tag}${tail}`,
  };
}

/**
 * 回填 OCR/类目/摘要。乐观锁的替代品:重试两次,还失败就落到
 * pending jsonl 里,下次启动可以捞出来补 —— 笔记里会留「识别中…」,
 * 至少不是静默丢数据。
 */
export async function writeBackWithRetry(config, payload, host = {}) {
  let last = { ok: false, path: null, reason: "" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      last = updateEntry(config, payload);
      if (last.ok) return last;
    } catch (err) {
      last = { ok: false, path: null, reason: String(err?.message || err) };
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
  }

  try {
    mkdirSync(join(tmpdir(), "dsh-capture"), { recursive: true });
    appendFileSync(PENDING_OCR_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`, "utf8");
  } catch {
    /* 兜底日志也写不了就只能打 warn */
  }
  host?.logger?.warn?.(`dsh-screenshot-classify: OCR 文字没能写回笔记(${last.reason}),已暂存到 ${PENDING_OCR_LOG}`);
  return last;
}

export { PENDING_OCR_LOG };
