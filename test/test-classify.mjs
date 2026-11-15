import { DEFAULT_CATEGORIES, CATEGORY_KEYS, APP_NAMES } from "../categories.mjs";
import {
  classifyOne,
  classifyScreenshot,
  isValidCategory,
  isTallScreenshot,
  isLandscape,
  isGamePackage,
} from "../classify.mjs";

/**
 * 规则分类器的行为钉子。
 *
 * 重点不是"把某张图判对"(那要靠真实相册),而是钉住几条**被实测推翻过**的规则,
 * 防止以后有人"顺手优化"又把它们加回来:
 *  · 裸时间正则不能当证据(状态栏永远有 16:12);
 *  · 「文字短」只能给梗图表情包,不能同时给二次元;
 *  · 目录先验在有文字时不给分;
 *  · 判决必须带 evidence,纯形态学要能被下游识别成"这是猜的"。
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

// ---- 1. 类目表形状 ----
console.log("=== 1. 类目表 ===");
check("18 个类目", DEFAULT_CATEGORIES.length === 18, String(DEFAULT_CATEGORIES.length));
check("类目 key 唯一", new Set(CATEGORY_KEYS).size === CATEGORY_KEYS.length);
check("包含用户要的五类语义", ["二次元", "游戏截图", "文字梗", "时政新闻", "生活日常"].every((k) => CATEGORY_KEYS.includes(k)), JSON.stringify(CATEGORY_KEYS));
check("APP_NAMES 非空", Object.keys(APP_NAMES).length >= 30, String(Object.keys(APP_NAMES).length));

// ---- 2. 形态学小工具 ----
console.log("=== 2. 形态学 ===");
check("tall 判据 0.38~0.62", isTallScreenshot(1080, 2400) && !isTallScreenshot(2400, 1080));
check("横屏判据 w > h*1.15", isLandscape(2400, 1080) && !isLandscape(1080, 2400));
check("米哈游包名算游戏", isGamePackage("com.miHoYo.Yuanshen") && isGamePackage("com.miHoYo.hkrpg"));
check("微信不是游戏", !isGamePackage("com.tencent.mm"));

// ---- 3. 微信聊天截图 ----
console.log("=== 3. 微信聊天 ===");
const chat = classifyOne({
  file: { path: "/x/1.png", name: "1.png", size: 1, mtime: 0 },
  source: { kind: "screenshot", dirHint: "DCIM-Screenshots", pkg: "com.tencent.mm" },
  ocr: { w: 1080, h: 2400, text: "对方正在输入 语音通话 你在干嘛 群聊" },
});
check("判成聊天记录", chat.category === "聊天记录", chat.category);
check("证据是 strong(包名)", chat.evidence === "strong", chat.evidence);
check("置信度够高", chat.confidence >= 0.82, String(chat.confidence));

// ---- 4. 裸时间正则绝不能被当证据 ----
console.log("=== 4. 裸时间不算证据 ===");
const timeOnly = classifyOne({
  file: { path: "/x/2.png", name: "2.png", size: 1, mtime: 0 },
  source: { kind: "screenshot", dirHint: "DCIM-Screenshots", pkg: "" },
  ocr: { w: 1080, h: 2400, text: "16:12" },
});
check("只有 16:12 不会判成生活日常", timeOnly.category !== "生活日常", timeOnly.category);
check("证据不是 strong", timeOnly.evidence !== "strong", timeOnly.evidence);

// ---- 5. 「文字短」只给梗图,不给二次元 ----
console.log("=== 5. 短文字只归梗图 ===");
const short = classifyOne({
  file: { path: "/x/3.png", name: "3.png", size: 1, mtime: 0 },
  source: { kind: "screenshot", dirHint: "Pictures-bili", pkg: "" },
  ocr: { w: 1080, h: 1080, text: "有点冷啊" },
});
check("短文字判梗图表情包", short.category === "梗图表情包", short.category);
check("短文字不会判成二次元", short.category !== "二次元", short.category);
check("短文字证据是 weak", short.evidence === "weak", short.evidence);

// ---- 6. 没有目录先验 ----
// 这一版**故意去掉了** photo-organizer 的「来源目录」先验：那个先验说的是
// 「这张图原本存在手机的哪个相册里」，而截图入库时图片是刚落地的临时文件，
// 目录永远是 DCIM-Screenshots 之类，跟画面内容无关。真要用它，只会把
// 「从 B 站存的图」这种偶然信息当成结论。
console.log("=== 6. 没有目录先验 ===");
const biliWithText = classifyOne({
  file: { path: "/x/4.png", name: "4.png", size: 1, mtime: 0 },
  source: { kind: "screenshot", dirHint: "Pictures-bili", pkg: "" },
  ocr: { w: 1080, h: 1080, text: "国家移民管理局提醒您办理手续 现在购买可分12期" },
});
check("目录名不参与判定(有文字)", biliWithText.category !== "二次元", biliWithText.category);

const biliNoText = classifyOne({
  file: { path: "/x/5.gif", name: "5.gif", size: 1, mtime: 0 },
  source: { kind: "screenshot", dirHint: "Pictures-bili", pkg: "" },
  ocr: { w: 1080, h: 1080, text: "" },
});
check("目录名不参与判定(无文字)", biliNoText.category === "摄影", biliNoText.category);
check("无文字无其它线索 → fallback", biliNoText.evidence === "fallback", biliNoText.evidence);
check("无文字无其它线索 置信度 0.2", Math.abs(biliNoText.confidence - 0.2) < 0.001, String(biliNoText.confidence));

// ---- 7. 无规则命中时的诚实兜底 ----
console.log("=== 7. 兜底 ===");
// 注意用**够长**的文字(>=40 字)且**不含任何类目关键词**:文字短会命中
// shorttext → 梗图表情包,含「今天/早上」会命中生活日常,都不是兜底路径。
const none = classifyOne({
  file: { path: "/x/6.png", name: "6.png", size: 1, mtime: 0 },
  source: { kind: "screenshot", dirHint: "DCIM-Screenshots", pkg: "" },
  ocr: {
    w: 1080,
    h: 400,
    text: "宋江有教养这是他祖上传下来的规矩所以咱们也得照着这个规矩办事情你明白了吗我真的说不清楚反正就是这样",
  },
});
check("有文字但零命中 → 文字梗", none.category === "文字梗", none.category);
check("兜底标记 fallback", none.evidence === "fallback", none.evidence);
check("兜底置信度 0.2", Math.abs(none.confidence - 0.2) < 0.001, String(none.confidence));

const noTextNone = classifyOne({
  file: { path: "/x/7.png", name: "7.png", size: 1, mtime: 0 },
  source: { kind: "screenshot", dirHint: "DCIM-Screenshots", pkg: "" },
  ocr: { w: 1080, h: 1000, text: "" },
});
check("没文字且零命中 → 摄影", noTextNone.category === "摄影", noTextNone.category);
check("这条也是 fallback", noTextNone.evidence === "fallback", noTextNone.evidence);

// ---- 8. 相机直出 ----
console.log("=== 8. 相机 ===");
const cam = classifyOne({
  file: { path: "/x/img_20260101_120000.jpg", name: "img_20260101_120000.jpg", size: 1, mtime: 0 },
  source: { kind: "camera", dirHint: "DCIM-Camera", pkg: "" },
  ocr: { w: 4000, h: 3000, text: "" },
});
check("相机照片判摄影", cam.category === "摄影", cam.category);
check("相机证据 camera", cam.evidence === "camera", cam.evidence);
check("相机置信度 0.8", Math.abs(cam.confidence - 0.8) < 0.001, String(cam.confidence));

// ---- 9. 游戏截图 ----
console.log("=== 9. 游戏 ===");
const game = classifyOne({
  file: { path: "/x/8.jpg", name: "8.jpg", size: 1, mtime: 0 },
  source: { kind: "screenshot", dirHint: "DCIM-Screenshots", pkg: "com.miHoYo.hkrpg" },
  ocr: { w: 2400, h: 1080, text: "抽卡 十连 保底 星琼" },
});
check("米哈游截图判游戏", game.category === "游戏截图", game.category);

// ---- 10. 时政新闻 ----
console.log("=== 10. 时政 ===");
const news = classifyOne({
  file: { path: "/x/9.png", name: "9.png", size: 1, mtime: 0 },
  source: { kind: "screenshot", dirHint: "DCIM-Screenshots", pkg: "" },
  ocr: { w: 1080, h: 2400, text: "新华社 9月29日 电 国务院 外交部 就此事发表声明 发布会" },
});
check("新闻稿判时政新闻", news.category === "时政新闻", news.category);
check("时政证据 strong", news.evidence === "strong", news.evidence);

// ---- 11. manual 覆盖 ----
console.log("=== 11. 人工指定 ===");
const manual = classifyScreenshot({
  filePath: "/x/10.png",
  width: 1080,
  height: 2400,
  text: "对方正在输入 群聊",
  source: { kind: "screenshot", dirHint: "DCIM-Screenshots", pkg: "com.tencent.mm" },
  manual: "二次元",
});
check("人工类目胜出", manual.category === "二次元", manual.category);
check("人工置信度 1", manual.confidence === 1, String(manual.confidence));
check("人工 evidence=manual", manual.evidence === "manual", manual.evidence);
check("人工带 manual 标记", manual.manual === true);

const badManual = classifyScreenshot({
  filePath: "/x/11.png",
  width: 1080,
  height: 2400,
  text: "对方正在输入 群聊",
  source: { kind: "screenshot", dirHint: "DCIM-Screenshots", pkg: "com.tencent.mm" },
  manual: "不存在的类目",
});
check("非法人工类目被忽略,回退规则", badManual.category === "聊天记录", badManual.category);
check("非法人工不产生 manual 标记", badManual.manual !== true);

// ---- 12. 白名单 ----
console.log("=== 12. 白名单 ===");
check("有效类目通过", isValidCategory("二次元"));
check("空串不通过", !isValidCategory(""));
check("undefined 不通过", !isValidCategory(undefined));
check("大小写不符不通过", !isValidCategory("SECOND"));

// ---- 13. 输出形状 ----
console.log("=== 13. 输出形状 ===");
const shape = classifyScreenshot({ filePath: "/x/12.png", width: 1080, height: 2400, text: "抽卡 十连", source: {} });
check("有 category", typeof shape.category === "string" && shape.category.length > 0);
check("有 confidence 且在 0..1", typeof shape.confidence === "number" && shape.confidence >= 0 && shape.confidence <= 1);
check("有 tags 数组", Array.isArray(shape.tags));
check("tags 最多 8 个", shape.tags.length <= 8, String(shape.tags.length));
check("有 evidence", typeof shape.evidence === "string");
check("有 textLen", typeof shape.textLen === "number");
check("width/height 为 0 也不崩", (() => { const r = classifyScreenshot({ filePath: "/x/13.png", width: 0, height: 0, text: "" }); return !!r.category; })());

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
