// 模型槽位链回归:顺序 / 去重 / 空槽跳过 / 失败换下一个 / 全失败报全量 / 三槽全空退回老路径。
//
// 全程用内存 fake,不联网、不真实等待。唯一需要真文件的是 test/sample.png
// —— prepareImage 会 readFileSync 它(和 0.3.x 一样,读图本身是本地操作)。
import assert from "node:assert/strict";
import { ocrImage, resolveOcrChain, parseModelRef, reasonOf } from "../ocr.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "test", "sample.png");

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

/** 造一个假宿主:stream 按 model 决定成功还是抛错,saveImage 计数。 */
function fakeHost(opts = {}) {
  const calls = [];
  const saveCount = { n: 0 };
  const models = opts.models ?? [{ id: "def", provider: "p", name: "def", inputModalities: ["text", "image"] }];
  const failModels = new Set(opts.failModels ?? []);
  const textOf = opts.textOf ?? (() => "识别结果 OK");
  const defaultSel = opts.defaultSel === undefined ? { provider: "p", model: "def" } : opts.defaultSel;

  const host = {
    llm: {
      async resolveModelInfo(provider, model) {
        const hit = models.find((m) => m.provider === provider && m.id === model);
        return hit ?? { provider, id: model, name: model, inputModalities: ["text", "image"] };
      },
      async listModels() {
        return models;
      },
      listProviders() {
        return [{ id: "p", name: "p" }];
      },
      stream(options) {
        calls.push(options);
        if (failModels.has(options.model)) throw new Error(`模型返回错误 BOOM: ${options.provider}/${options.model}`);
        return (async function* () {
          yield { type: "text-delta", index: 0, text: textOf(options.model) };
          yield { type: "finish", reason: { kind: "stop" } };
        })();
      },
    },
    attachments: {
      // 故意不给 imageLimits:跳过大小校验,专测链本身
      async saveImage({ mediaType }) {
        saveCount.n += 1;
        return { attachmentId: "sha256:fake", mediaType, bytes: 1, width: 1, height: 1 };
      },
    },
    agentDefaultModel: { currentSelection: () => defaultSel },
    logger: { info() {}, warn() {} },
  };
  return { host, calls, saveCount };
}

// ① 顺序:三个槽位按 主模型 → 备选 1 → 备选 2 排开
await group("顺序:三槽依次 a,b,c", () => {
  const { host } = fakeHost();
  const chain = resolveOcrChain({ model: { primary: "p/a", fallback1: "p/b", fallback2: "p/c" } }, host.llm, host);
  assert.equal(chain.length, 3);
  assert.deepEqual(chain.map((c) => c.model), ["a", "b", "c"]);
  assert.deepEqual(chain.map((c) => c.label), ["主模型", "备选 1", "备选 2"]);
});

// ② 去重:同一个路由出现多次只留第一次(裸 id 用默认 provider 补齐后算同一个)
await group("去重:重复路由后出现的忽略", () => {
  const { host } = fakeHost({ defaultSel: { provider: "p", model: "def" } });
  const chain = resolveOcrChain({ model: { primary: "p/a", fallback1: "p/a", fallback2: "a" } }, host.llm, host);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].model, "a");
  assert.equal(chain[0].label, "主模型");
});

// ③ 空槽跳过
await group("空槽:primary 空则只剩 fallback1", () => {
  const { host } = fakeHost();
  const chain = resolveOcrChain({ model: { primary: "", fallback1: "p/b", fallback2: "" } }, host.llm, host);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].model, "b");
  assert.equal(chain[0].label, "备选 1");
});

// ④ 主模型失败 → 第二个被调用;且图片只 saveImage 一次
await group("失败切换:主模型抛错后走备选,且 saveImage 只 1 次", async () => {
  const { host, calls, saveCount } = fakeHost({
    failModels: ["a"],
    textOf: (model) => `来自 ${model}`,
  });
  const text = await ocrImage(
    { ocr: { mode: "host", prompt: "识别文字" }, model: { primary: "p/a", fallback1: "p/b", fallback2: "" } },
    src,
    host,
  );
  assert.equal(text, "来自 b");
  assert.deepEqual(calls.map((c) => c.model), ["a", "b"]);
  assert.equal(saveCount.n, 1, "整条链只应调一次 saveImage");
});

// ⑤ 全失败:错误信息要带全三条路由 + 箭头 + 至少一个原因词
await group("全失败:错误里列出三个候选与原因", async () => {
  const { host } = fakeHost({ failModels: ["a", "b", "c"] });
  await assert.rejects(
    () =>
      ocrImage(
        { ocr: { mode: "host", prompt: "识别文字" }, model: { primary: "p/a", fallback1: "p/b", fallback2: "p/c" } },
        src,
        host,
      ),
    (err) => {
      const m = String(err?.message ?? "");
      for (const key of ["p/a", "p/b", "p/c"]) assert.ok(m.includes(key), `错误信息缺少 ${key}:${m}`);
      assert.ok(m.includes("→"), `错误信息缺少 「→」:${m}`);
      assert.ok(
        /timeout|http-error|empty-text|no-image-support|unknown/.test(m),
        `错误信息缺少原因词:${m}`,
      );
      return true;
    },
  );
});

// ⑥ 三槽全空 → 退回宿主路径(hostModel 空时用宿主默认模型 def)
await group("三槽全空:退回宿主路径,用的就是宿主默认模型", async () => {
  const { host, calls } = fakeHost({ defaultSel: { provider: "p", model: "def" } });
  const text = await ocrImage({ ocr: { mode: "host", prompt: "识别文字" }, model: { primary: "", fallback1: "", fallback2: "" } }, src, host);
  assert.equal(text, "识别结果 OK");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "def");
});

// 附:parseModelRef / reasonOf 的边界(槽位解析靠它们,顺手钉住)
await group("parseModelRef:拆分与补 provider", () => {
  assert.deepEqual(parseModelRef("p/a", null), { provider: "p", model: "a" });
  assert.deepEqual(parseModelRef("  a  ", "p"), { provider: "p", model: "a" });
  assert.equal(parseModelRef("", "p"), null);
  assert.equal(parseModelRef("a", null), null);
  // 残缺写法("/a"、"p/")不算合法引用,但也不抛错:它们落进补 defaultProvider 那条分支,
  // 后面发请求时自然失败 —— 比在解析阶段静默丢掉槽位更好排查。
  assert.deepEqual(parseModelRef("/a", "p"), { provider: "p", model: "/a" });
  assert.deepEqual(parseModelRef("p/", "p"), { provider: "p", model: "p/" });
});

await group("reasonOf:归类", () => {
  assert.equal(reasonOf(new Error("宿主模型调用超时(120s)")), "timeout");
  const e1 = new Error("模型 p/a 没有声明图片输入");
  e1.code = "no-image-support";
  assert.equal(reasonOf(e1), "no-image-support");
  const e2 = new Error("x");
  e2.code = "empty-text";
  assert.equal(reasonOf(e2), "empty-text");
  assert.equal(reasonOf(new Error("模型返回错误 BOOM")), "http-error");
  assert.equal(reasonOf(new Error("莫名其妙")), "unknown");
});

if (failed > 0) {
  console.error(`\n[model-chain] ${failed} 项失败`);
  process.exitCode = 1;
} else {
  console.log("\n[model-chain] 全部通过");
}
