// 笔记排版回归:多行 OCR 必须写成 Obsidian 块引用,回读要能原样拼回来。
//
// 覆盖 6 组:
//   ① 写入格式(每行都以 > 开头,空行是裸 >)
//   ② 回读拼回(parseEntries 拼出的 ocrText 与写入时一致)
//   ③ 幂等(连调两次不叠行)
//   ④ 不误吃(分类行 / 摘要行各留 1 行,且排在 OCR 块之后)
//   ⑤ 老格式兼容(单行 > OCR: 的旧笔记照样读得懂)
//   ⑥ 注释不被污染(OCR 续行不能混进用户注释)
//
// 用临时 vault,跑完清理。不联网、不碰真实笔记。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, ensureVault } from "../config.mjs";
import { appendEntry, updateEntry, parseEntries, dailyNotePath } from "../storage.mjs";

const vaultPath = mkdtempSync(join(tmpdir(), "scc-ocr-layout-"));
const date = "2026-11-17";
let failed = 0;

async function group(label, fn) {
  try {
    await fn();
    console.log(`OK   ${label}`);
  } catch (err) {
    console.log(`FAIL ${label} → ${err?.message ?? err}`);
    failed += 1;
  }
}

function readNote() {
  return readFileSync(dailyNotePath(config, date), "utf8");
}

const config = resolveConfig({ vaultPath });
// 真实流程里是 saveAttachment() 顺手建目录;这里不落图,得自己建一次
ensureVault(config);

// 每个断言组用不同的图片名,免得互相定位到对方那条
const MULTI = "attachments/20261117_090500_文档.png";
const MULTI_TEXT = "第一行\n第二行\n\n第四行";

// ① 写入格式
await group("写入格式:每行以 > 开头,空行为裸 >", () => {
  appendEntry(config, { date, time: "09:05", kind: "文档", imageRel: MULTI, ocrText: MULTI_TEXT });
  const note = readNote();
  assert.ok(note.includes("> OCR: 第一行"), "缺少首行");
  assert.ok(note.includes("\n> 第二行\n"), "第二行没有 > 前缀");
  assert.ok(note.includes("\n>\n"), "空行应写成裸 >");
  assert.ok(note.includes("\n> 第四行\n"), "第四行没有 > 前缀");
  // 整块每一行都必须以 > 开头(不允许出现裸续行)
  const lines = note.split(/\r?\n/);
  const oi = lines.findIndex((l) => l === "> OCR: 第一行");
  assert.ok(oi >= 0, "找不到 OCR 首行");
  for (const l of lines.slice(oi, oi + 4)) assert.ok(l.startsWith(">"), `第 ${oi} 行起的块里有裸行:${JSON.stringify(l)}`);
});

// ② 回读拼回
await group("回读拼回:ocrText 与写入一致", () => {
  const [entry] = parseEntries(readNote());
  assert.equal(entry.ocrText, MULTI_TEXT);
});

// ③ 幂等
await group("幂等:updateEntry 连调两次不叠行", () => {
  updateEntry(config, { date, time: "09:05", imageRel: MULTI, ocrText: MULTI_TEXT });
  updateEntry(config, { date, time: "09:05", imageRel: MULTI, ocrText: MULTI_TEXT });
  const note = readNote();
  assert.equal((note.match(/^> OCR: /gm) || []).length, 1, "OCR 行应只有 1 条");
  assert.equal((note.match(/^> 第二行$/gm) || []).length, 1, "第二行应只有 1 条");
  const [entry] = parseEntries(note);
  assert.equal(entry.ocrText, MULTI_TEXT, "连调后回读内容不应变");
});

// ④ 不误吃:分类 / 摘要各 1 行,且排在 OCR 块之后
await group("不误吃:分类与摘要各 1 行且排在 OCR 块之后", () => {
  for (let i = 0; i < 2; i += 1) {
    updateEntry(config, {
      date,
      time: "09:05",
      imageRel: MULTI,
      ocrText: MULTI_TEXT,
      category: "数学",
      weak: true,
      summary: "一句话。",
    });
  }
  const note = readNote();
  assert.equal((note.match(/^> 分类: /gm) || []).length, 1, "分类行应只有 1 条");
  assert.equal((note.match(/^> 摘要: /gm) || []).length, 1, "摘要行应只有 1 条");
  const lines = note.split(/\r?\n/);
  const ocrIdx = lines.findIndex((l) => l.startsWith("> OCR: "));
  const catIdx = lines.findIndex((l) => l.startsWith("> 分类: "));
  const sumIdx = lines.findIndex((l) => l.startsWith("> 摘要: "));
  assert.ok(catIdx > ocrIdx, "分类行应在 OCR 首行之后");
  assert.ok(sumIdx > catIdx, "摘要行应在分类行之后");
  // 摘要行不属于 OCR 续行,回读时不能把「一句话。」混进 ocrText
  const [entry] = parseEntries(note);
  assert.equal(entry.ocrText, MULTI_TEXT, "摘要被误当成 OCR 续行");
  assert.equal(entry.summary, "一句话。");
});

// ⑤ 老格式兼容
await group("老格式兼容:单行 > OCR: 的旧笔记", () => {
  const old = ["## 09:05 #文档", "", "![a.png](<attachments/a.png>)", "", "> OCR: 老笔记没有类目标签", ""].join("\n");
  const [entry] = parseEntries(old);
  assert.equal(entry.ocrText, "老笔记没有类目标签");
  assert.equal(entry.category, null);
});

// ⑥ 注释不被污染
await group("注释不被污染:note 里没有 OCR 续行与元数据行", () => {
  const rel = "attachments/20261117_091000_文档.png";
  appendEntry(config, {
    date,
    time: "09:10",
    kind: "文档",
    imageRel: rel,
    ocrText: MULTI_TEXT,
    note: "我的注释",
  });
  const entry = parseEntries(readNote()).find((e) => e.imageRel === rel);
  assert.ok(entry, "找不到带注释的那条");
  assert.equal(entry.note, "我的注释");
  assert.ok(!String(entry.note).includes("第二行"), "OCR 续行混进了注释");
  assert.ok(!String(entry.note).includes("分类:"), "分类行混进了注释");
  assert.ok(!String(entry.note).includes("摘要:"), "摘要行混进了注释");
});

rmSync(vaultPath, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n[ocr-layout] ${failed} 项失败`);
  process.exitCode = 1;
} else {
  console.log("\n[ocr-layout] 全部通过");
}
