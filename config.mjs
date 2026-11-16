import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  pollIntervalMs: 200,
  cooldownMs: 2000,
  // 默认库路径留空:未配置时采集功能自动停用并告警,绝不创建无关目录。
  // 首次使用请在 Web 设置 / config.json 里配置你自己的 Obsidian 库路径。
  vaultPath: "",
  inboxFolder: "收件箱",
  attachmentsFolder: "attachments",
  knowledgeFolder: "知识库",
  summaryFolder: "总结",
  archiveFolder: "归档",
  recycleFolder: "回收站",
  ocr: {
    // 默认走**宿主大模型**(DSH 0.1.7+ 的 llm + attachments 服务):零配置、不用另申请 key。
    // 取值:"host" | "off"。没有外部回落通道 —— 候选模型全失败时直接报错并列出试过的路由。
    // 历史键 model / apiKey / endpoint 已废弃:残留在本文件里也不会被读取、不报错。
    mode: "host",
    // 空 = 跟随 DSH 当前默认模型;填了则强制用该模型(仍需它声明 inputModalities 含 image)
    hostModel: "",
    prompt: "请识别图片中的全部文字内容,原样输出;数学公式用 LaTeX 输出。只输出识别结果,不要任何解释。",
  },
  // 模型槽位:三个都可留空(留空 = 不参与)。值写 "provider/model" 或裸 model id。
  // 按 主模型 → 备选 1 → 备选 2 的顺序试,前一个失败才试下一个;重复的路由后出现的忽略。
  model: { primary: "", fallback1: "", fallback2: "" },
  dialog: {
    // 悬浮窗出现在哪儿。三种模式各管各的:
    //   "cursor"   = 跟着鼠标(默认,历史行为)
    //   "fixed"    = 出现在 fixedX / fixedY 这个屏幕坐标上
    //   "remember" = 沿用上次关闭时的位置和大小;没有记录时退回 "cursor"
    positionMode: "cursor",
    // positionMode = "fixed" 时生效。单位是**屏幕像素**(多显示器虚拟桌面坐标系,
    // 主屏左上方的副屏 x 是负数,所以允许负值)。
    fixedX: 0,
    fixedY: 0,
    offsetX: 16,
    offsetY: 16,
    previewMaxWidth: 320,
    // 固定尺寸。0 = 不固定(宽度按内容算,高度按内容算)。
    // 设了 width 时预览图按窗口宽度重新缩放;设了 height 时多出来的高度
    // 全部给注释框(它是窗里唯一适合拉伸的控件)。
    width: 0,
    height: 0,
    // 悬浮窗自动关闭秒数。0 = 关掉自动关闭,一直等用户点。
    // 倒计时在你敲键盘 / 改注释 / 点窗口时重新喂满;到点等同「忽略」(copy),
    // 剪贴板原样保留、不写库。
    autoCloseSec: 0,
    // 悬浮窗配色主题。四套都是同一副布局、同一套间距,只换配色与头部图标画法 ——
    // 所以切换主题不会让窗口变形,也不会改变任何操作方式。
    //   "c1" = 青碧扫描(默认):青绿主色 + 四角细括号 + 单条扫描线
    //   "c2" = 靛蓝取景:靛蓝主色 + 粗括号 + 双扫描线
    //   "c3" = 石墨取景:近黑主色 + 浅灰头 + 细括号 + 实心短条
    //   "c4" = 紫罗兰取景:紫色主色 + 圆角弧括号 + 断线中点圆
    theme: "c1",
  },
  // 分类:入库时按内容给截图打一个 #类目 标签。
  // 规则引擎是纯本地的(不打网络、不花钱),所以默认开着。
  classify: {
    enabled: true,
    // 低于这个置信度就在 OCR 行下面补一句「分类: …（弱）」。
    // 0.55 与 photo-organizer 的默认一致;截图里 weak 占比很高(实测 71%),
    // 调高只会让更多条目被标弱,不会让判定变准。
    minConfidence: 0.55,
  },
  // 摘要:只对「存文档」(#文档)生效 —— 存图片本来就没有文字可总结。
  summarize: {
    // "off" = 不写;"rules" = 本地抽取式(免费,默认);"host" = 交给宿主文本模型(更通顺,花一点点钱)
    mode: "rules",
    // 留空 = 跟随主模型槽位(modelPrimary);主模型也空才用宿主默认模型。
    // 也可写 "provider/model" 或裸 model id
    hostModel: "",
    // 摘要长度上限(汉字)。rules 模式下也按这个截断。
    maxChars: 120,
  },
  // 同一屏被剪贴板连写两遍(Snipping Tool 常见)时的去重窗口,毫秒;0 = 关闭去重。
  // 不进设置面板(保持面板干净),需要时改 config.json。
  dupWindowMs: 6000,
  organize: { addBacklinks: true },
});

export function configDir() {
  return join(homedir(), ".dsh-screenshot-capture");
}

export function configPath() {
  return join(configDir(), "config.json");
}

/**
 * 递归解包 DSH 0.1.7+ 的 volatile 配置形态。
 *
 * 宿主会把 Config schema 里盖过 `.volatile()` 的字段包成 Volatile cell
 * (`{ get(): value }`，自身可枚举键只有 `get`) 再传进 `apply(ctx, input)`；
 * 嵌套的普通对象不受影响。直接把它当值用会出事:
 *   - `JSON.stringify(cell)` → `{}`(写进 watcher-config.json 就是 `{}`)
 *   - `path.join(cell, "收件箱")` → TypeError(path must be of type string)
 * 所以任何来自宿主的配置都要先过这一层。
 */
export function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") {
    if (typeof value.get === "function" && Object.keys(value).every((k) => k === "get")) {
      return plain(value.get());
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

/** 合并默认配置 + 配置文件 + 运行时入参(DSh 插件配置覆盖最高) */
export function resolveConfig(input = {}) {
  let file = {};
  try {
    if (existsSync(configPath())) {
      file = JSON.parse(readFileSync(configPath(), "utf8"));
    }
  } catch {
    file = {};
  }
  const merged = mergeDeep(structuredClone(DEFAULT_CONFIG), file);
  return mergeDeep(merged, plain(input));
}

export function saveConfig(config) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf8");
}

function mergeDeep(base, patch) {
  if (patch === undefined || patch === null) return base;
  if (typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = typeof v === "object" && v !== null && !Array.isArray(v) && typeof out[k] === "object" && out[k] !== null
      ? mergeDeep(out[k], v)
      : v;
  }
  return out;
}

export function ensureVault(config) {
  const folders = [
    join(config.vaultPath, config.inboxFolder),
    join(config.vaultPath, config.inboxFolder, config.attachmentsFolder),
    join(config.vaultPath, config.knowledgeFolder),
    join(config.vaultPath, config.summaryFolder),
    join(config.vaultPath, config.archiveFolder),
    join(config.vaultPath, config.recycleFolder),
  ];
  for (const dir of folders) mkdirSync(dir, { recursive: true });
  return folders;
}
