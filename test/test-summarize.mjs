import { SUMMARY_MODES, extractiveSummary, normalizeSummary, summarizeOcr } from "../summarize.mjs";

/**
 * 摘要模块的行为钉子。
 *
 * 这个模块的契约只有一条最重要：**永不抛错**。截图入库已经完成了，
 * 摘要只是锦上添花，它挂了绝不能让用户的截图看起来像失败。
 * 所以下面每一条错误路径都要钉住"返回空摘要 + 带 via/error，而不是 throw"。
 */

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

// ---------------------------------------------------------------- 0. 常量
console.log("=== 0. 模式常量 ===");
check("三种模式", SUMMARY_MODES.length === 3, SUMMARY_MODES.join(","));
check("包含 off", SUMMARY_MODES.includes("off"));
check("包含 rules", SUMMARY_MODES.includes("rules"));
check("包含 host", SUMMARY_MODES.includes("host"));

// ---------------------------------------------------------- 1. 抽取式摘要
console.log("=== 1. extractiveSummary ===");
check("空输入返回空", extractiveSummary("") === "");
check("null 不崩", extractiveSummary(null) === "");
check("纯空白返回空", extractiveSummary("   \n\t ") === "");

// 挑信息量最大的那句：带数字、中文够长、长度适中
const multi = "好的。这件商品价格是 199 元，今天下单可以减 20 元。谢谢。";
const picked = extractiveSummary(multi);
check("从多句里挑出带数字的那句", picked.includes("199"), picked);
check("不把「好的」这种碎句当摘要", picked !== "好的。", picked);

// 单句就直接用它
check("单句原样返回", extractiveSummary("会议室在三楼") === "会议室在三楼");

// 超长要截断且带省略号
const long = "这是一段非常长的文字".repeat(20);
const cut = extractiveSummary(long, 30);
check("超长被截断", cut.length <= 30, String(cut.length));
check("截断带省略号", cut.endsWith("…"), cut);

// 换行与多空格要压平
const messy = "第一行\n\n   第二行   有空格";
check("换行被压平", !extractiveSummary(messy).includes("\n"), extractiveSummary(messy));

// ------------------------------------------------ 2. normalizeSummary 清洗
console.log("=== 2. normalizeSummary ===");
check("空返回空", normalizeSummary("") === "");
check("去掉包裹引号", normalizeSummary("“一张游戏截图”") === "一张游戏截图");
check("去掉 markdown 强调", normalizeSummary("**一张聊天截图**") === "一张聊天截图");
check("去掉「摘要:」前缀", normalizeSummary("摘要: 一张购物小票") === "一张购物小票");
check("去掉「这是一张」前缀", normalizeSummary("这是一张：快递单") === "快递单");
check("只取第一段", normalizeSummary("第一段内容\n\n第二段内容") === "第一段内容");
check("超过 200 字截断", normalizeSummary("字".repeat(300)).length <= 200);

// ---------------------------------------- 3. summarizeOcr：off / 空 / 失败占位
console.log("=== 3. off 与空输入 ===");
const offRes = await summarizeOcr({ summarizeMode: "off" }, "任何文字");
check("off 模式返回空", offRes.summary === "", offRes.summary);
check("off 模式 via=off", offRes.via === "off", offRes.via);

const emptyRes = await summarizeOcr({ summarizeMode: "rules" }, "   ");
check("空文字返回空摘要", emptyRes.summary === "");
check("空文字不报错", !emptyRes.error, String(emptyRes.error));

// 「（识别失败:xxx）」是 core.mjs 写进笔记的占位文字，不能拿去总结
const failText = "（识别失败:宿主模型调用超时(120s)）";
const failRes = await summarizeOcr({ summarizeMode: "rules" }, failText);
check("识别失败占位不总结", failRes.summary === "", failRes.summary);

// ------------------------------------------------------ 4. rules 模式
console.log("=== 4. rules 模式 ===");
// 多句才能抽出「一句摘要」；单句的抽取结果等于原文，会被刻意丢弃（见 4b）
const MULTI = "支付成功 金额 35.00 元。收款方 某某便利店。交易时间 2026-11-13 14:30。";
const rulesRes = await summarizeOcr({ summarizeMode: "rules" }, MULTI);
check("rules 有摘要", Boolean(rulesRes.summary), rulesRes.summary);
check("rules 摘要短于原文", rulesRes.summary.length < MULTI.length);
check("rules via=rules", rulesRes.via === "rules", rulesRes.via);
check("rules 不产生 error", !rulesRes.error, String(rulesRes.error));

// 4b. 摘要与原文一字不差时不写
// 单句 OCR（一句话的新闻、一张单据）抽出来必然就是原文,写进笔记只是把 OCR 抄第二遍。
console.log("=== 4b. 原文重复时丢弃摘要 ===");
const verbatim = await summarizeOcr({ summarizeMode: "rules" }, "会议改到三楼");
check("单句不重复写成摘要", verbatim.summary === "", verbatim.summary);
const punctOnly = await summarizeOcr({ summarizeMode: "rules" }, "会议改到三楼。");
check("只差标点也算重复", punctOnly.summary === "", punctOnly.summary);
const trimmed = await summarizeOcr({ summarizeMode: "rules" }, "  会议改到三楼  ");
check("只差空白也算重复", trimmed.summary === "", trimmed.summary);

// maxChars 生效
const shortRes = await summarizeOcr({ summarizeMode: "rules", summarizeMaxChars: 20 }, "一二三四五六七八九十".repeat(10));
check("maxChars 生效", shortRes.summary.length <= 20, String(shortRes.summary.length));

// ------------------------------------------------------ 5. host 模式降级
console.log("=== 5. host 模式 ===");

/** 造一个只有 text 能力的假宿主；reply 决定模型输出 */
const fakeHost = (reply) => ({
  llm: {
    listProviders: () => [{ id: "p1" }],
    listModels: async () => [{ id: "m1" }],
    resolveModelInfo: async () => ({}),
    async *stream() {
      yield { type: "text-delta", index: 0, text: reply };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: "p1", model: "m1" }) },
  logger: { warn: () => {}, info: () => {} },
});

const hostOk = await summarizeOcr(
  { summarizeMode: "host" },
  "会议室改到三楼，时间不变",
  fakeHost("一条改期通知，会议地点换成三楼。"),
);
check("host 模式拿到模型摘要", hostOk.summary.includes("三楼"), hostOk.summary);
check("host via=host", hostOk.via === "host", hostOk.via);

// 模型输出带引号/前缀 → 被 normalizeSummary 清掉
const hostDirty = await summarizeOcr(
  { summarizeMode: "host" },
  "随便什么文字",
  fakeHost("“摘要: 一张购物截图”"),
);
check("host 输出被清洗", hostDirty.summary === "一张购物截图", hostDirty.summary);

// 没有 llm 服务 → 降级到 rules，不抛错
const noLlm = await summarizeOcr({ summarizeMode: "host" }, MULTI, {});
check("无 llm 时降级 rules", noLlm.via === "rules", noLlm.via);
check("降级后仍有摘要", Boolean(noLlm.summary), noLlm.summary);
check("降级带 error 说明", Boolean(noLlm.error), String(noLlm.error));

// 模型抛错 → 同样降级，不抛
const boomHost = {
  llm: {
    listProviders: () => [{ id: "p1" }],
    listModels: async () => [{ id: "m1" }],
    resolveModelInfo: async () => ({}),
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("模型返回错误 QUOTA: 额度用尽");
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: "p1", model: "m1" }) },
  logger: { warn: () => {}, info: () => {} },
};
let threw = false;
let boomRes = null;
try {
  boomRes = await summarizeOcr({ summarizeMode: "host" }, MULTI, boomHost);
} catch {
  threw = true;
}
check("模型抛错不向上传播", threw === false);
check("模型抛错降级 rules", boomRes && boomRes.via === "rules", boomRes && boomRes.via);
check("模型抛错仍给出摘要", Boolean(boomRes && boomRes.summary), boomRes && boomRes.summary);

// 模型返回空 → 降级并说明
const emptyModel = await summarizeOcr({ summarizeMode: "host" }, MULTI, fakeHost(""));
check("模型空回复降级 rules", emptyModel.via === "rules", emptyModel.via);
check("模型空回复仍给出摘要", Boolean(emptyModel.summary), emptyModel.summary);

// 配置缺字段时使用默认值，不崩
const bare = await summarizeOcr({}, "支付成功 金额 35.00 元");
check("缺配置不崩", typeof bare.summary === "string");
check("缺配置默认走 rules", bare.via === "rules", bare.via);

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
