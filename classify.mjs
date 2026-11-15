/**
 * 单张截图的规则分类器。移植自 dsh-photo-organizer 的 classify.mjs。
 *
 * 与原版的差别（三处，都有理由）：
 * 1. 原版按「整个相册」跑，有 relDir 与路径先验；这里一次只判一张截图，
 *    没有 relDir，所以去掉了目录先验与 scope 过滤 —— 截图落在哪个目录
 *    跟画面内容无关，拿它当证据就是噪声。
 * 2. 分类必须等 OCR 结果出来之后再跑（#文档 这类最重要的信号就是文字）。
 * 3. 输出多一个 `manual` 标记：用户在弹窗里直接指定了类目时，规则不参与，
 *    但仍要给出 evidence/confidence，好让下游知道「这是人选的，不是猜的」。
 *
 * 打分权重与原版一致，不要随手改 —— 每条权重后面都有实测教训（见注释）。
 */
import { DEFAULT_CATEGORIES, APP_NAMES } from './categories.mjs';

/** 竖屏截图：宽高比落在 0.38~0.62 之间（手机截图几乎都在这） */
export function isTallScreenshot(w, h) {
  if (!w || !h) return false;
  const r = w / h;
  return r > 0.38 && r < 0.62;
}

/** 横屏：宽明显大于高 */
export function isLandscape(w, h) {
  if (!w || !h) return false;
  return w > h * 1.15;
}

/** 游戏包名：这些厂商的手游截图像素级标着包名，是最硬的证据 */
const GAME_PKG_RE =
  /miHoYo|mihoyo|HoYoverse|hypergryph|Sunborn|bluepoch|papegames|bilibili\.azurlane|tmgp|netease\.(onmyoji|g78)|levelinf|longyuan|yingxiong|kurogame|seasun|zlongame|droidhang/i;

export function isGamePackage(pkg) {
  return Boolean(pkg && GAME_PKG_RE.test(pkg));
}

/**
 * 从 OCR 记录里取全文。
 * 缓存记录形如 { path, w, h, blocks: [[conf, text], ...], text, n }，
 * 有的记录只有 blocks 没有 text，两种都要能读。
 */
function collectText(ocr) {
  if (!ocr) return '';
  if (typeof ocr === 'string') return ocr;
  if (typeof ocr.text === 'string' && ocr.text) return ocr.text;
  if (Array.isArray(ocr.blocks)) {
    return ocr.blocks
      .map((b) => (Array.isArray(b) ? b[1] : typeof b === 'string' ? b : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** 统计 needle 在 hay 里出现的次数，上限 10 次（防止整页重复的界面文字刷分） */
function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    n += 1;
    from = i + needle.length;
    if (n >= 10) break;
  }
  return n;
}

/** 从文本里挑出命中的关键词，按权重排序取前 limit 个，用作标签 */
function topKeywords(text, categories, limit = 3) {
  const out = [];
  const lower = text.toLowerCase();
  for (const cat of categories) {
    for (const k of cat.keywords || []) {
      if (k && lower.includes(k.toLowerCase())) out.push({ k, cat: cat.key });
    }
  }
  return [...new Set(out.map((o) => o.k))].slice(0, limit);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * 判一张截图。
 *
 * @param {object} input
 * @param {object} input.file   { path, name, size, mtime }
 * @param {object} input.source { kind, dirHint, pkg } —— kind ∈ screenshot|camera|wechat|video|screenrecord|photo
 * @param {object} input.ocr    { w, h, blocks, text } 或纯字符串
 * @param {Array}  [categories] 类目表，默认用内置 18 类
 * @returns {{category, confidence, tags, scores, reason, textLen, hasText, evidence}}
 */
export function classifyOne(input, categories = DEFAULT_CATEGORIES) {
  const file = input?.file || {};
  const source = input?.source || {};
  const ocr = input?.ocr;
  const text = collectText(ocr);
  const w = Number(ocr?.w) || 0;
  const h = Number(ocr?.h) || 0;

  const hasText = text.trim().length > 0;
  const chars = text.trim().length;
  const tall = isTallScreenshot(w, h);

  const scores = Object.create(null);
  const reasons = Object.create(null);
  for (const cat of categories) {
    scores[cat.key] = 0;
    reasons[cat.key] = [];
  }

  const add = (key, value, reason) => {
    if (!(key in scores)) return;
    scores[key] += value;
    if (reason) reasons[key].push(reason);
  };

  // 1) App 包名 —— 最硬的证据，给 4.0
  const haystack = `${source.pkg || ''} ${source.dirHint || ''} ${file.name || ''}`.toLowerCase();
  for (const cat of categories) {
    for (const app of cat.apps || []) {
      if (haystack.includes(app.toLowerCase())) add(cat.key, 4.0, `app:${app}`);
    }
  }

  // 2) 特征短语
  // 单命中只给 0.35 倍（几乎可以忽略），至少命中 2 个不同词才给满分。
  // 教训：实测「宝贝」出现在情话里、「评论」出现在游戏里，单关键词下结论错得离谱。
  if (hasText) {
    const lower = text.toLowerCase();
    for (const cat of categories) {
      if (!cat.keywords?.length) continue;
      let raw = 0;
      let hits = 0;
      for (const k of cat.keywords) {
        const cnt = countOccurrences(lower, k.toLowerCase());
        if (cnt > 0) {
          hits += 1;
          raw += (k.length >= 4 ? 1.2 : 0.7) * Math.min(cnt, 3);
        }
      }
      if (hits === 1) add(cat.key, Math.min(raw, 1.2) * 0.35);
      else if (hits >= 2) add(cat.key, raw + 0.8 + 0.35 * Math.min(hits - 2, 4), `${hits}kws`);
    }

    // 3) 正则
    for (const cat of categories) {
      for (const pat of cat.patterns || []) {
        try {
          if (new RegExp(pat, 'i').test(text)) add(cat.key, 2.0, `re:${pat}`);
        } catch {
          /* 正则写错不该让整条分类失败 */
        }
      }
    }
  }

  // 4) 形态学
  if (hasText && tall) {
    for (const key of ['聊天记录', '支付账单', '购物', '问答社区', '社交媒体', '学习资料', '游戏截图']) {
      add(key, 0.5, 'tall');
    }
  }
  if (chars > 400) {
    for (const key of ['学习资料', '文档票据', '问答社区', '聊天记录']) add(key, 0.4, 'longtext');
  }
  // 文字特别少时只给「梗图表情包」加分。
  // 教训：早先同时给「梗图表情包」与「二次元」各 +0.7，两者并列后冠军由类目表
  // 的声明顺序决定 —— 等于用「文字少」宣布「这是动漫」。982 张就是这么错判的。
  if (hasText && chars < 40) add('梗图表情包', 0.7, 'shorttext');
  // 没有文字时**不给任何类目加分**。
  //
  // 早先这里是「摄影 / 二次元 / 梗图表情包 各 +1.4」——等于让「没有文字」这张票
  // 平均分给三个类目，冠军由声明顺序决定：无文字的截图会莫名其妙变成「摄影」，
  // 而摄影的语义是相机直出。那是在用形态学冒充结论。
  //
  // 现在的做法：没有文字就承认没有证据，让它走下面的兜底（→ 摄影，evidence
  // 标成 fallback、置信度 0.2），或者由**真线索**接手：
  //   · 相机来源 → 摄影（source.kind，2.5）
  //   · Pictures-bili / Pictures-QQ 目录 → 二次元（目录先验，2.0/1.4）
  // 三者都是「有据可查」，而不是「猜一个」。

  // 5) 来源类型
  if (source.kind === 'camera') add('摄影', hasText ? 2.2 : 2.5, 'camera');
  if (source.kind === 'wechat') add('聊天记录', 0.3, 'wechat-file');
  if (isGamePackage(source.pkg)) add('游戏截图', 3.0, 'game-pkg');

  // 6) 选冠军：严格大于，同分时先声明者胜
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  let best = sorted[0]?.[0] || '';
  let bestScore = sorted[0]?.[1] || 0;

  // 一条规则都没命中时的兜底。
  // 有文字 → 「文字梗」（承认这是一段文字但推不出场景）；
  // 没文字 → 「摄影」（它是不是照片说不准，但至少不是有据可查的截图场景；
  //          留给人工或后续视觉复核）。
  // 教训：早先直接落到「摄影」，357 张长文/段子截图全被标成摄影，看起来像整批失败。
  let fallback = false;
  if (!best || bestScore <= 0) {
    fallback = true;
    best = hasText ? '文字梗' : '摄影';
    bestScore = 0;
  }

  // 证据强度：分数高不等于判得准，要回答「靠什么赢的」
  const why = reasons[best] || [];
  let evidence = 'none';
  if (fallback) evidence = 'fallback';
  else if (why.some((r) => r.startsWith('app:') || r.startsWith('re:') || r.endsWith('kws'))) evidence = 'strong';
  else if (why.some((r) => r.startsWith('camera') || r === 'game-pkg')) evidence = 'camera';
  else if (why.some((r) => r.startsWith('dir-'))) evidence = 'dir';
  else if (best) evidence = 'weak';

  // 置信度按证据强度给，不按分数给 —— 分数是算出来的，
  // 靠形态学蒙对的判定分数同样可能不低。
  const runnerUp = sorted[1]?.[1] || 0;
  const margin = bestScore > 0 ? (bestScore - runnerUp) / bestScore : 0;
  let confidence;
  if (evidence === 'strong') confidence = 0.6 * Math.min(1, bestScore / 4.5) + 0.4 * margin;
  else if (evidence === 'camera') confidence = 0.8;
  else if (evidence === 'dir') confidence = hasText ? 0.45 : 0.72;
  else if (evidence === 'weak') confidence = 0.3 + 0.1 * Math.min(1, bestScore / 1.5);
  else confidence = 0.2;
  if ((reasons[best] || []).some((r) => r.startsWith('app:'))) {
    confidence = Math.max(confidence, 0.82);
  }
  confidence = round2(confidence);

  // 标签：人可读的来源信息 + 命中的关键词
  const tags = [];
  for (const cat of categories) {
    for (const app of cat.apps || []) {
      if (haystack.includes(app.toLowerCase())) tags.push(APP_NAMES[app] || app);
    }
  }
  if (source.kind === 'screenshot') tags.push('截图');
  if (source.kind === 'camera') tags.push('相机');
  if (tall) tags.push('竖屏');
  if (!hasText) tags.push('无文字');
  if (bestScore > 0) {
    const second = sorted[1];
    if (second && second[1] >= Math.max(2.5, bestScore * 0.55)) tags.push(second[0]);
  }
  if (hasText) tags.push(...topKeywords(text, categories, 3));

  return {
    category: best || '摄影',
    confidence,
    tags: [...new Set(tags)].slice(0, 8),
    scores,
    reason: (reasons[best] || []).slice(0, 4).join(' '),
    textLen: text.length,
    hasText,
    evidence,
  };
}

/**
 * 给弹窗/host 用的便捷入口：从一次识别结果直接判类目。
 *
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {string} [opts.text]     OCR 出来的文字
 * @param {object} [opts.source]   guessSource() 的结果
 * @param {string} [opts.manual]   用户在弹窗里指定的类目；给了就跳过规则
 */
export function classifyScreenshot(opts = {}) {
  const { filePath = '', width = 0, height = 0, text = '', source = {}, manual = '' } = opts;
  const name = filePath.split(/[\\/]/).pop() || '';
  const ocr = { w: width, h: height, text };

  // 人工指定要先过白名单再采信。
  //
  // 这个值是从 PowerShell 事件日志里读回来的字符串（弹窗拼的 JSON 行），
  // 中间没有类型保证：拼错一个字、老版本助手传来旧类目名、甚至手改
  // events.log 都能塞进任意文本。类目最终会变成笔记标题里的 `#标签`，
  // 放任意字符串进去等于让人往库里写标签 —— 所以不认识就当没指定，
  // 退回规则判定，而不是把脏值写下去。
  if (manual && isValidCategory(manual)) {
    // 人工指定：不做规则判定，但保留可解释性
    return {
      category: manual,
      confidence: 1,
      tags: ['人工', ...(text.trim() ? [] : ['无文字'])],
      scores: {},
      reason: 'manual',
      textLen: text.length,
      hasText: text.trim().length > 0,
      evidence: 'manual',
      manual: true,
    };
  }

  const res = classifyOne({ file: { path: filePath, name }, source, ocr });
  return { ...res, manual: false };
}

/** 类目是否合法（弹窗传来的值要做白名单校验，别把任意字符串写进笔记） */
export function isValidCategory(name, categories = DEFAULT_CATEGORIES) {
  return categories.some((c) => c.key === name);
}
