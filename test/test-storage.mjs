// 存储+整理模块单测(独立于 DSH,验证 vault 写入逻辑)
import { resolveConfig, ensureVault } from "../config.mjs";
import { saveAttachment, appendEntry, updateEntry, updateEntryOcr, parseEntries, todayString } from "../storage.mjs";
import { organizeDay } from "../organize.mjs";
import { mkdirSync, copyFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 仓库根 = <repo>/test 的上一级
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vault = join(root, "test", "test-vault");
rmSync(vault, { recursive: true, force: true });
const config = resolveConfig({ vaultPath: vault });
ensureVault(config);

const src = join(root, "test", "sample.png");
const date = todayString();
const results = [];

// 1. 存文档:图片入附件 + 笔记占位(带注释 + 重点标记)
const relDoc = saveAttachment(config, src, date, "20260821_103000", "文档");
results.push(["saveAttachment(文档)", relDoc]);
// 带类目 + 弱标记占位:标题行就要有 `#类目`,OCR 行下面挂 `> 分类: …（弱）`
appendEntry(config, {
  date, time: "10:30", kind: "文档", imageRel: relDoc,
  ocrText: null, category: "学习资料", weak: true,
  note: "老师讲的必考题", isKey: true,
});
results.push(["appendEntry(文档占位+注释+重点)", "OK"]);

// 2. OCR + 摘要回填
updateEntry(config, {
  date, time: "10:30", imageRel: relDoc,
  ocrText: "测试题目: 3x + 2 = 8,解得 x = 2",
  category: "学习资料", weak: true,
  summary: "一道一元一次方程题,要求解出 x。",
});
results.push(["updateEntry(OCR+摘要)", "OK"]);

// 2b. 幂等:同一份回填再来一次,弱行与摘要行都不能变成两行
updateEntry(config, {
  date, time: "10:30", imageRel: relDoc,
  ocrText: "测试题目: 3x + 2 = 8,解得 x = 2",
  category: "学习资料", weak: true,
  summary: "一道一元一次方程题,要求解出 x。",
});
{
  const txt = readFileSync(join(vault, "收件箱", `${date}.md`), "utf8");
  const weakCount = (txt.match(/^> 分类: /gm) || []).length;
  const sumCount = (txt.match(/^> 摘要: /gm) || []).length;
  results.push(["重复回填不叠加(分类行)", `${weakCount} 行`]);
  results.push(["重复回填不叠加(摘要行)", `${sumCount} 行`]);
}

// 3. 存图片(纯注释,不勾重点)
const relImg = saveAttachment(config, src, date, "20260821_103500", "图片");
appendEntry(config, { date, time: "10:35", kind: "图片", imageRel: relImg, note: "这页图留着参考" });
results.push(["appendEntry(图片+纯注释)", relImg]);

// 3b. 重点标记但不填注释
const relImg2 = saveAttachment(config, src, date, "20260821_104000", "图片");
appendEntry(config, { date, time: "10:40", kind: "图片", imageRel: relImg2, isKey: true });
results.push(["appendEntry(图片+只重点)", relImg2]);

// 4. 解析回读
const note = readFileSync(join(vault, "收件箱", `${date}.md`), "utf8");
const entries = parseEntries(note);
results.push(["parseEntries count", String(entries.length)]);
results.push(["entry[0]", JSON.stringify({ time: entries[0]?.time, kind: entries[0]?.kind, note: entries[0]?.note, isKey: entries[0]?.isKey })]);
results.push(["entry[1] 纯注释", JSON.stringify({ note: entries[1]?.note, isKey: entries[1]?.isKey })]);
results.push(["entry[2] 只重点", JSON.stringify({ note: entries[2]?.note, isKey: entries[2]?.isKey })]);

// 5. 晚间整理:保留全部
//
// 这里**故意只给 10:35 指定分类**,10:30 不给 —— 10:30 入库时已经判成
// 「学习资料」了。整理这一步必须沿用它,不能因为用户没再手动指定就退回
// 「未分类」。否则「自动分类」会在归档时被抹平,前面白做。
const org = organizeDay(config, {
  date,
  keep: null, // all
  categories: { "10:35": "数学" },
  summaryTitle: "",
});
results.push(["organize kept", `${org.keptCount}/${org.discardedCount}`]);
results.push(["organize files", JSON.stringify(org.files.map((f) => f.replace(vault, "")))]);
results.push(["10:30 沿用了入库时的类目", org.categories["10:30"] ?? "(空)"]);
results.push(["10:35 用了整理时指定的类目", org.categories["10:35"] ?? "(空)"]);

// 6. 校验知识库笔记内容(双链 / 图片 / 重点小节 / 摘要)
const kNote = readFileSync(org.files[0], "utf8");
results.push(["知识库笔记含双链", kNote.includes("[[INDEX]]") ? "OK" : "MISSING"]);
results.push(["知识库笔记含图片", kNote.includes("![[") ? "OK" : "MISSING"]);
results.push(["知识库笔记含重点小节", kNote.includes("## 重点") && kNote.includes("# **重点**") ? "OK" : "MISSING"]);
results.push(["知识库笔记含注释", kNote.includes("老师讲的必考题") ? "OK" : "MISSING"]);
results.push(["知识库笔记含摘要节", kNote.includes("## 摘要") ? "OK" : "MISSING"]);
results.push(["摘要正文进笔记", kNote.includes("一道一元一次方程题") ? "OK" : "MISSING"]);
results.push(["frontmatter 带自动类目", kNote.includes("tags: [截图, 文档, 学习资料]") ? "OK" : "MISSING"]);
results.push(["摘要排在文字之前", kNote.indexOf("## 摘要") < kNote.indexOf("## 文字") ? "OK" : "ORDER"]);
results.push(["类目标签未被抹成未分类", kNote.includes("未分类") ? "LEAKED" : "OK"]);

// 7. 收件箱已归档
results.push(["收件箱已归档", !existsSync(join(vault, "收件箱", `${date}.md`)) ? "OK" : "STILL EXISTS"]);

console.log(results.map(([k, v]) => `${k.padEnd(30)} => ${v}`).join("\n"));
