import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ensureVault } from "./config.mjs";

export const KIND = { DOC: "文档", IMG: "图片" };

/**
 * 条目块在笔记里的样子（新格式,#文档）:
 *
 *   ## 14:30 #文档 #梗图表情包
 *
 *   ![x.png](<attachments/20261113_143000_文档.png>)
 *
 *   > OCR: 全场最佳 …
 *   > 分类: 梗图表情包（弱）
 *   > 摘要: 一张游戏结算截图,配了一句调侃。
 *
 * 三个 `>` 行都是可选的:
 *   - OCR 行只有 #文档 有（#图片 根本不做识别）;
 *   - 分类行只在**证据弱**的时候出现,否则光看标题就够;
 *   - 摘要行只有 #文档 且 summarize 开着才有。
 *
 * 老格式（没有类目标签、没有后两行）必须还能被 parseEntries 读懂 —— 已有的
 * 收件箱笔记不会因为升级插件就解析失败。
 */

export function stampParts(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const fileStamp = `${date.replaceAll("-", "")}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return { date, fileStamp, time };
}

export function dailyNotePath(config, date) {
  return join(config.vaultPath, config.inboxFolder, `${date}.md`);
}

export function attachmentRelPath(config, date, fileStamp, kind) {
  return `${config.attachmentsFolder}/${fileStamp}_${kind}.png`;
}

/**
 * 同步重试写入。Obsidian / 云同步盘(BaiduSyncdisk 这类)会短暂占用文件(EBUSY/EPERM),
 * 一次写失败就丢掉整段 OCR 文字太亏:
 *   ① 退避重试拉长到 ~4.6s(100/300/600/1200/2400ms);
 *   ② 直接写被占用时改走「写临时文件 + 原子替换」;
 *   ③ 仍失败才抛错,由调用方兜底暂存识别结果。
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 环境不允许同步等待就直接继续 */
  }
}

function writeFileRetry(path, text, attempts = 6) {
  const delays = [100, 300, 600, 1200, 2400];
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      writeFileSync(path, text, "utf8");
      return;
    } catch (err) {
      lastErr = err;
      if (!["EBUSY", "EPERM", "EACCES"].includes(err.code)) throw err;
      try {
        const tmp = `${path}.scc-tmp`;
        writeFileSync(tmp, text, "utf8");
        renameSync(tmp, path);
        return;
      } catch (err2) {
        lastErr = err2;
      }
      sleepSync(delays[Math.min(i, delays.length - 1)]);
    }
  }
  throw lastErr;
}

/**
 * 把剪贴板临时图复制进 vault 附件,返回 vault 内相对路径。
 * 同一秒内连拍两张时 `fileStamp` 会撞车(文件名相同 → 后者覆盖前者),
 * 所以目标已存在就顺延 `_2`、`_3`…(相对路径会带这个后缀,笔记里也对得上)。
 */
export function saveAttachment(config, srcPath, date, fileStamp, kind) {
  ensureVault(config);
  let rel = attachmentRelPath(config, date, fileStamp, kind);
  let dest = join(config.vaultPath, config.inboxFolder, rel);
  for (let i = 2; existsSync(dest); i += 1) {
    rel = `${config.attachmentsFolder}/${fileStamp}_${kind}_${i}.png`;
    dest = join(config.vaultPath, config.inboxFolder, rel);
  }
  copyFileSync(srcPath, dest);
  return rel;
}

const NOTE_HEADER = `# {date} 收件箱

> 每日截图收件箱,晚间整理后归档。\`#文档\` = 含 OCR 文字,\`#图片\` = 纯图片;标题里的第二个标签是自动判定的类目。

`;

function ensureDailyNote(config, date) {
  const path = dailyNotePath(config, date);
  if (!existsSync(path)) {
    writeFileSync(path, NOTE_HEADER.replace("{date}", date), "utf8");
  }
  return path;
}

/** 标题行:`## 14:30 #文档` 或 `## 14:30 #文档 #梗图表情包` */
function headerLine(time, kind, category) {
  return category ? `## ${time} #${kind} #${category}` : `## ${time} #${kind}`;
}

/** 证据弱时那行;不动标题行,免得影响按标签检索 */
function weakLine(category, weak) {
  return weak && category ? `> 分类: ${category}（弱）` : null;
}

/**
 * 多行 OCR → Obsidian 块引用。
 *
 * Obsidian 里连续以 `>` 开头的行是**同一个块引用**,所以多行文字必须逐行加 `> `,
 * 空行写成裸 `>` —— 否则第二行起就是普通正文,既不在引用块里,也会被
 * parseEntries 的注释过滤误当成用户注释。
 *
 * 首行固定是 `> OCR: …`(占位符 `> OCR: 识别中…` 也是这个形状,能被后续整段替换)。
 */
export function ocrBlockLines(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const out = [`> OCR: ${lines[0]}`];
  for (const line of lines.slice(1)) out.push(line === "" ? ">" : `> ${line}`);
  return out;
}

/**
 * 是否 OCR 块的续行。
 *
 * `> 分类:` / `> 摘要:` / 新的 `> OCR:` 一律不算 —— 它们在笔记里是**并列的元数据行**,
 * 不是上一行文字的延续;误吞掉它们就等于每次回填都把类目和摘要删了。
 */
function isOcrContinuation(line) {
  if (line === ">") return true;
  if (!line.startsWith("> ")) return false;
  if (/^> (分类|摘要): /.test(line)) return false;
  return !line.startsWith("> OCR: ");
}

/**
 * 向当天笔记追加一条记录。
 *
 * `ocrText === null` 是 **#文档 的占位** 语义:先把图和标题写进去(绝不让用户的
 * 截图丢失),等 OCR 回来再用 updateEntry 回填文字、类目、摘要。
 * `#图片` 不 OCR,所以它传 ocrText 为 undefined,一次写完。
 */
export function appendEntry(config, {
  date,
  time,
  kind,
  imageRel,
  category = "",
  weak = false,
  ocrText = null,
  summary = "",
  note = "",
  isKey = false,
} = {}) {
  const path = ensureDailyNote(config, date);
  const block = [
    "",
    headerLine(time, kind, category),
    "",
    `![${imageRel.split("/").pop()}](<${imageRel}>)`,
    "",
  ];
  if (kind === KIND.DOC) {
    // 多行 OCR 逐行加 `> `,空行写成裸 `>` —— 见 ocrBlockLines 的说明。
    block.push(...ocrBlockLines(ocrText === null ? "识别中…" : (ocrText || "（无文字）")));
    const w = weakLine(category, weak);
    if (w) block.push(w);
    if (summary) block.push(`> 摘要: ${summary}`);
    block.push("");
  } else {
    const w = weakLine(category, weak);
    if (w) block.push(w, "");
  }
  if (note || isKey) {
    if (isKey) block.push("# **重点**", "");
    if (note) block.push(note, "");
  }
  const existing = readFileSync(path, "utf8");
  const updated = existing.replace(/\n*$/, "\n") + block.join("\n") + "\n";
  writeFileRetry(path, updated);
  return path;
}

/**
 * 按**图片文件名**定位条目块。
 *
 * 为什么不按 `## <time>` 定位:同一分钟内连拍两张 time 一样;文件名带秒数,
 * 一定唯一。历史实现用整段正则硬匹配,行尾必须是纯 LF、占位符必须连着写,
 * 换个格式就匹配不上还静默返回 null —— 现在统一走这里。
 */
function locateBlock(text, imageRel) {
  const fileName = String(imageRel ?? "").split("/").pop();
  if (!fileName) return { ok: false, reason: "缺少图片文件名" };
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const imgIdx = text.search(new RegExp(`!\\[[^\\]]*${esc(fileName)}[^\\]]*\\]\\(`));
  if (imgIdx === -1) return { ok: false, reason: `笔记里找不到图片 ${fileName}` };
  const headerIdx = text.lastIndexOf("## ", imgIdx);
  if (headerIdx === -1) return { ok: false, reason: `图片 ${fileName} 不在任何条目块里` };
  const nextIdx = text.indexOf("\n## ", imgIdx);
  const end = nextIdx === -1 ? text.length : nextIdx;
  return { ok: true, headerIdx, end, block: text.slice(headerIdx, end) };
}

/**
 * 回填一条 **#文档** 记录:补类目、填 OCR 文字、必要时加弱标记与摘要。
 *
 * 幂等:重复调用不会叠加行 —— 每条 `>` 行都是先删旧再加新。
 */
export function updateEntry(config, { date, time, imageRel, ocrText, category = "", weak = false, summary = "" } = {}) {
  const path = dailyNotePath(config, date);
  if (!existsSync(path)) return { ok: false, path: null, reason: `笔记不存在(${date})` };

  const text = readFileSync(path, "utf8");
  const hit = locateBlock(text, imageRel);
  if (!hit.ok) return { ok: false, path: null, reason: hit.reason };

  const lines = hit.block.split(/\r?\n/);

  // 1) 标题行:替换掉「#文档」后面的所有标签,用最新的类目
  const headerIdx = lines.findIndex((l) => /^## \d{2}:\d{2} #(?:文档|图片)/.test(l));
  if (headerIdx >= 0) {
    const m = lines[headerIdx].match(/^## (\d{2}:\d{2}) (#文档|#图片)/);
    lines[headerIdx] = headerLine(m[1], m[2].slice(1), category);
  }

  // 2) 三个 `>` 行:先清掉旧的分类/摘要行,再按需插到 OCR 行后面
  const isMeta = (l) => /^> (分类|摘要): /.test(l);
  const kept = lines.filter((l) => !isMeta(l));

  const ocrIdx = kept.findIndex((l) => /^> OCR: /.test(l));
  const extra = [];
  const w = weakLine(category, weak);
  if (w) extra.push(w);
  if (summary) extra.push(`> 摘要: ${summary}`);

  if (ocrIdx >= 0) {
    // 整个 OCR 块(首行 + 续行)一起换掉,否则旧的多行文字会残留在下面。
    let end = ocrIdx + 1;
    while (end < kept.length && isOcrContinuation(kept[end])) end += 1;
    kept.splice(ocrIdx, end - ocrIdx, ...ocrBlockLines(ocrText || "（无文字）"), ...extra);
  } else {
    // 老笔记没有 OCR 行（或被人删了）:补一个,插在图片行后面
    const imgIdx = kept.findIndex((l) => l.startsWith("!["));
    const blockLines = [...ocrBlockLines(ocrText || "（无文字）"), ...extra];
    if (imgIdx >= 0) kept.splice(imgIdx + 1, 0, "", ...blockLines);
    else kept.push(...blockLines);
  }

  const newBlock = kept.join("\n");
  writeFileRetry(path, text.slice(0, hit.headerIdx) + newBlock + text.slice(hit.end));
  return { ok: true, path, reason: "" };
}

/**
 * 兼容旧调用名。历史测试与外部脚本用的是 `updateEntryOcr`,
 * 行为等价于「只回填 OCR,不动类目」。
 */
export function updateEntryOcr(config, { date, time, imageRel, ocrText }) {
  return updateEntry(config, { date, time, imageRel, ocrText });
}

/**
 * 解析当天笔记为条目列表。
 *
 * 兼容两种标题行:
 *   `## 14:30 #文档`              ← 老格式,没有类目
 *   `## 14:30 #文档 #梗图表情包`   ← 新格式
 */
export function parseEntries(noteText) {
  const entries = [];
  const chunks = noteText.split(/^## /m).slice(1);
  for (const chunk of chunks) {
    const header = chunk.match(/^(\d{2}:\d{2}) (#文档|#图片)([^\r\n]*)/);
    if (!header) continue;
    const [, time, tag, tail] = header;
    const tags = (tail.match(/#([^\s#]+)/g) || []).map((s) => s.slice(1));
    const body = chunk.slice(header[0].length);
    const img = body.match(/!\[[^\]]*\]\(<([^>]+)>\)/)?.[1] ?? null;
    // OCR 是**块**读:首行 `> OCR: …` + 后续所有引用续行,空行是裸 `>`。
    // 老笔记只有单行,没有续行 → 读出来就是那一行,天然兼容。
    const bodyLines = body.split(/\r?\n/);
    let ocrText = null;
    const oi = bodyLines.findIndex((l) => /^> OCR: /.test(l));
    if (oi >= 0) {
      const parts = [bodyLines[oi].slice("> OCR: ".length)];
      let j = oi + 1;
      while (j < bodyLines.length && isOcrContinuation(bodyLines[j])) {
        parts.push(bodyLines[j] === ">" ? "" : bodyLines[j].slice(2));
        j += 1;
      }
      ocrText = parts.join("\n");
    }
    const catLine = body.match(/^> 分类: (.*)$/m)?.[1] ?? null;
    const category = tags[0] || (catLine ? catLine.replace(/（弱）$/, "") : null);
    const summary = body.match(/^> 摘要: (.*)$/m)?.[1] ?? null;
    const isKey = /^# \*\*重点\*\*\s*$/m.test(body);
    // 所有 `>` 行都是插件自己写的元数据/OCR(含续行与裸 `>`),不该混进用户注释。
    const noteLines = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("![") && !l.startsWith(">") && l !== "# **重点**");
    const note = noteLines.length ? noteLines.join("\n") : null;
    entries.push({ time, kind: tag.slice(1), imageRel: img, ocrText, category, summary, note, isKey });
  }
  return entries;
}

export function readDailyNote(config, date) {
  const path = dailyNotePath(config, date);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** 归档:当天收件箱笔记移动到 归档 文件夹 */
export function archiveDailyNote(config, date) {
  ensureVault(config);
  const src = dailyNotePath(config, date);
  if (!existsSync(src)) return null;
  const dest = join(config.vaultPath, config.archiveFolder, `${date}.md`);
  renameSync(src, dest);
  return dest;
}

export function todayString(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
