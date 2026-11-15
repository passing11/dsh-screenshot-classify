import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { appendEntry, updateEntry, updateEntryOcr, parseEntries } from "../storage.mjs";
import { resolveConfig, ensureVault } from "../config.mjs";
import { saveAttachment } from "../storage.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

/**
 * 条目格式 + 回填幂等性。
 *
 * 这一版专门盯三件事:
 *  ① 带类目标签的标题行能被子标题正则认出来(旧写法只匹配 `## HH:MM #文档`
 *    紧接着的行尾,加了类目就失配 —— 表现为晚间整理读不到任何条目);
 *  ② 弱判定行 / 摘要行是**追加**的,且在重复回填时不会越叠越多;
 *  ③ 存的顺序稳定:OCR → 分类 → 摘要,与用户读的顺序一致。
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vault = join(root, "test", "format-vault");
rmSync(vault, { recursive: true, force: true });
const config = resolveConfig({ vaultPath: vault });
ensureVault(config);
const src = join(root, "test", "sample.png");

const date = "2026-11-13";
const rel1 = saveAttachment(config, src, date, "20261113_143000", "文档");
// 1) 占位:先落图 + OCR 占位符,保证截图不会因为 OCR 慢而丢
appendEntry(config, {
  date,
  time: "14:30",
  kind: "文档",
  imageRel: rel1,
  ocrText: null,
});
// 2) 回填:OCR + 类目 + 弱标记 + 摘要,一次写完
updateEntry(config, {
  date,
  time: "14:30",
  imageRel: rel1,
  ocrText: "全场最佳 对面五个都在逃",
  category: "梗图表情包",
  weak: true,
  summary: "一张游戏结算截图,配了一句调侃。",
});
// 3) 再回填一次(幂等):不该出现第二行「分类:」「摘要:」
updateEntry(config, {
  date,
  time: "14:30",
  imageRel: rel1,
  ocrText: "全场最佳 对面五个都在逃",
  category: "梗图表情包",
  weak: true,
  summary: "一张游戏结算截图,配了一句调侃。",
});

const rel2 = saveAttachment(config, src, date, "20261113_150200", "图片");
appendEntry(config, {
  date,
  time: "15:02",
  kind: "图片",
  imageRel: rel2,
  category: "摄影",
  weak: true,
});

const notePath = join(vault, "收件箱", `${date}.md`);
const text = readFileSync(notePath, "utf8");

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

console.log(text);
console.log("---- 断言 ----");

check("标题行带类目标签", text.includes("## 14:30 #文档 #梗图表情包"));
check("图片条目带类目标签", text.includes("## 15:02 #图片 #摄影"));
check("OCR 行写进去了", text.includes("> OCR: 全场最佳 对面五个都在逃"));
check("弱判定行存在", text.includes("> 分类: 梗图表情包（弱）"));
check("摘要行存在", text.includes("> 摘要: 一张游戏结算截图,配了一句调侃。"));
check("弱行只出现一次(幂等)", text.split("> 分类: 梗图表情包（弱）").length - 1 === 1);
check("摘要行只出现一次(幂等)", text.split("> 摘要: 一张游戏结算截图").length - 1 === 1);
check("占位符已被替换掉", !text.includes("> OCR: 识别中…"));

const order = ["## 14:30", "> OCR:", "> 分类:", "> 摘要:"].map((m) => text.indexOf(m));
check(
  "顺序为 标题→OCR→分类→摘要",
  order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])),
  JSON.stringify(order),
);

// 图片条目没有 OCR 行,弱判定行要挂在图片下面而不是丢失
const imgBlock = text.slice(text.indexOf("## 15:02"));
check("图片条目有弱判定行", imgBlock.includes("> 分类: 摄影（弱）"));
check("图片条目没有 OCR 行", !imgBlock.includes("> OCR:"));

// parseEntries 必须认得新格式
const entries = parseEntries(text);
check("parseEntries 读到 2 条", entries.length === 2, String(entries.length));
const e1 = entries.find((e) => e.time === "14:30");
check("parseEntries 保住类目", e1 && e1.category === "梗图表情包", JSON.stringify(e1 && e1.category));
check("parseEntries 保住摘要", e1 && e1.summary === "一张游戏结算截图,配了一句调侃。");
check("parseEntries 保住 OCR", e1 && e1.ocrText === "全场最佳 对面五个都在逃");
check("parseEntries 的 note 不混入元信息行", e1 && !/分类:|摘要:/.test(e1.note || ""), JSON.stringify(e1 && e1.note));

// 兼容老格式:没有类目标签的历史笔记仍然能读
const legacy = parseEntries(
  [
    "## 09:05 #文档",
    "",
    "![a.png](<attachments/a.png>)",
    "",
    "> OCR: 老笔记没有类目标签",
    "",
  ].join("\n"),
);
check("老格式仍可解析", legacy.length === 1 && legacy[0].ocrText === "老笔记没有类目标签");
check("老格式 category 为 null", legacy[0] && legacy[0].category === null, JSON.stringify(legacy[0] && legacy[0].category));

// 兼容包装:updateEntryOcr 仍然可用(内部走 updateEntry)
const date2 = "2026-11-14";
const rel3 = saveAttachment(config, src, date2, "20261114_080000", "文档");
appendEntry(config, { date: date2, time: "08:00", kind: "文档", imageRel: rel3, ocrText: null });
const r = updateEntryOcr(config, { date: date2, time: "08:00", imageRel: rel3, ocrText: "兼容包装测试" });
check("updateEntryOcr 兼容包装可用", r.ok === true, JSON.stringify(r));

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
