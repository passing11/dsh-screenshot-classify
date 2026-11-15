import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureVault } from "./config.mjs";
import { archiveDailyNote, parseEntries, readDailyNote } from "./storage.mjs";

/**
 * 晚间整理(MVP):
 *   输入: 保留的条目列表 + 分类映射 + 当日总结标题
 *   输出: 知识库/<分类>/<date>_<time>_<kind>.md(含图片/OCR/相关双链)
 *         知识库/<分类>/INDEX.md 索引
 *         总结/<date>.md 当日总结(链接全部保留条目 + 上一篇总结)
 *         收件箱当天笔记移入归档
 * 所有双链均为确定性生成(按文件名),不是 AI 自由文本。
 */

function escFilenamePart(s) {
  return s.replace(/[\\/:*?"<>|]/g, "_").trim();
}

function noteTitleOf({ time, kind }) {
  return `截图 ${time}${kind === "文档" ? "" : "（图片）"}`;
}

export function listEntriesForDate(config, date) {
  const text = readDailyNote(config, date);
  return parseEntries(text);
}

export function organizeDay(config, { date, keep, categories = {}, summaryTitle = "" }) {
  ensureVault(config);
  const entries = listEntriesForDate(config, date);
  const kept = Array.isArray(keep)
    ? entries.filter((e) => keep.includes(e.time))
    : entries; // "all"

  const written = [];
  for (const entry of kept) {
    // 分类优先级:晚间整理时人工指定的 > 入库时规则判定/人工指定的 > 未分类。
    //
    // 第三条兜底看着不痛不痒,其实是这条链路的关键:入库时已经判过一次类目
    // (写进了标题行的 `#类目`),整理时用户没再指定,就必须沿用它。否则
    // 「自动分类」这件事会在归档这一步被抹平成一张大杂烩「未分类」——
    // 那等于前面白做。
    const auto = entry.category || "";
    const cat = escFilenamePart(categories[entry.time] || auto || "未分类");
    const file = `${date.replaceAll("-", "")}_${entry.time.replace(":", "")}_${entry.kind}.md`;
    const notePath = join(config.vaultPath, config.knowledgeFolder, cat, file);

    const prevLinks = previousNotesInCategory(config, cat, file);
    const backlinks = [`[[${date} 总结]]`];
    const keyBlock = (entry.note || entry.isKey)
      ? [
          "## 重点",
          "",
          ...(entry.isKey ? ["# **重点**", ""] : []),
          ...(entry.note ? [entry.note, ""] : []),
        ]
      : [];
    // 摘要单独成节,和 OCR 原文分开 —— 摘要是给人扫的,原文是给人核的。
    const summaryBlock = entry.summary ? ["## 摘要", "", entry.summary, ""] : [];
    const body = [
      "---",
      `tags: [截图, ${entry.kind}, ${cat}]`,
      `date: ${date} ${entry.time}`,
      "---",
      "",
      `# ${summaryTitle && categories[entry.time] ? `${summaryTitle}` : noteTitleOf(entry)}`,
      "",
      `![[${entry.imageRel.split("/").pop()}]]`,
      "",
      ...keyBlock,
      ...summaryBlock,
      "## 文字",
      "",
      entry.ocrText ? entry.ocrText : "（无 OCR 文字）",
      "",
      "## 相关",
      "",
      ...prevLinks.map((p) => `- [[${p}]]`),
      "- [[INDEX]]",
      ...backlinks.map((b) => `- ${b}`),
      "",
    ].join("\n");

    mkdirSync(join(config.vaultPath, config.knowledgeFolder, cat), { recursive: true });
    writeFileSync(notePath, body, "utf8");
    written.push({ cat, file, path: notePath, entry });
    updateIndex(config, cat, file, entry);
  }

  const summaryPath = writeSummary(config, { date, written, summaryTitle });

  // 收件箱当天笔记 → 归档
  const archived = archiveDailyNote(config, date);

  return {
    date,
    keptCount: kept.length,
    discardedCount: entries.length - kept.length,
    categories: Object.fromEntries(written.map((w) => [w.entry.time, w.cat])),
    summaryPath,
    archived,
    files: written.map((w) => w.path),
  };
}

function previousNotesInCategory(config, cat, excludeFile) {
  const dir = join(config.vaultPath, config.knowledgeFolder, cat);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "INDEX.md" && f !== excludeFile)
    .sort()
    .map((f) => f.replace(/\.md$/, ""));
}

function updateIndex(config, cat, file, entry) {
  const dir = join(config.vaultPath, config.knowledgeFolder, cat);
  const indexPath = join(dir, "INDEX.md");
  const title = noteTitleOf(entry);
  const line = `- [[${file.replace(/\.md$/, "")}]] — ${title}`;
  let text = "";
  if (existsSync(indexPath)) {
    text = readFileSync(indexPath, "utf8");
    if (!text.includes(`[[${file.replace(/\.md$/, "")}]]`)) text += line + "\n";
  } else {
    text = [`# ${cat}`, "", `> 该分类下的截图笔记索引(晚间整理自动生成)。`, "", line, ""].join("\n");
  }
  writeFileSync(indexPath, text, "utf8");
}

function writeSummary(config, { date, written, summaryTitle }) {
  const dir = join(config.vaultPath, config.summaryFolder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}.md`);
  const title = summaryTitle || `${date} 当日总结`;
  const lines = [
    "---",
    "tags: [总结]",
    "date: " + date,
    "---",
    "",
    `# ${title}`,
    "",
    "## 今日留存",
    "",
    ...written.map((w) => `- [[${w.file.replace(/\.md$/, "")}]] — ${w.entry.time} ${w.entry.kind}（${w.cat}）`),
    "",
  ];
  const prev = previousSummary(config, date);
  if (prev.length > 0) {
    lines.push("## 上一篇总结", "", ...prev.map((p) => `- [[${p}]]`), "");
  }
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

function previousSummary(config, date) {
  const dir = join(config.vaultPath, config.summaryFolder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== `${date}.md`)
    .sort()
    .slice(-3)
    .map((f) => f.replace(/\.md$/, ""));
}
