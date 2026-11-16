// OCR 冒烟:在有宿主 llm 的环境里真识别一次 test/sample.png。
//
// 0.4.0 起 OCR 只走宿主大模型(没有外部 API key 通道了),所以能不能真调,
// 取决于跑这个脚本时有没有宿主 llm 句柄:
//  * 直接在终端 `node test/test-ocr.mjs` → 没有宿主 → 打印一行配置后跳过(exit 0);
//  * 在宿主进程内(或用 `dev-run.mjs` 注入 globalThis.__DSH_HOST__)跑 → 真调一次。
//
// 之所以在「本机没有宿主」时不判失败:这是本地 CI 的常态,让它红会把整条
// npm test 变成永远失败。
import { resolveConfig } from "../config.mjs";
import { ocrImage, resolveOcrChain } from "../ocr.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "test", "sample.png");
const config = resolveConfig();

const slots = config.model || {};
console.log(
  `[ocr-test] mode=${config.ocr.mode} hostModel=${config.ocr.hostModel || "（空）"} ` +
    `primary=${slots.primary || "（空）"} fallback1=${slots.fallback1 || "（空）"} fallback2=${slots.fallback2 || "（空）"}`,
);

const host = globalThis.__DSH_HOST__ ?? null;

if (config.ocr.mode !== "host") {
  console.log("[ocr-test] ocr.mode 不是 host,跳过真实 OCR 联调。");
  process.exit(0);
}
if (!host?.llm || typeof host.llm.stream !== "function") {
  console.log("[ocr-test] 当前没有宿主 llm 句柄,跳过真实 OCR 联调(需在 DSH 进程内运行)。");
  process.exit(0);
}

const chain = resolveOcrChain(config, host.llm, host);
console.log(
  chain.length > 0
    ? `[ocr-test] 候选链:${chain.map((c) => `${c.label}=${c.provider}/${c.model}`).join(" → ")}`
    : "[ocr-test] 三个槽位都空,将走自动选路(hostModel → 宿主默认 → 目录里第一个声明 image 的)。",
);

try {
  const text = await ocrImage(config, src, host);
  console.log("[ocr-test] 成功,识别结果:");
  console.log(text);
} catch (err) {
  console.error("[ocr-test] 失败:", err.message);
  process.exitCode = 1;
}
