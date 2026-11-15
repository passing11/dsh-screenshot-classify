/**
 * 给 #文档 类截图写一段总结。
 *
 * 为什么要单独一个模块：总结是**可选**的第二步（OCR 已经有结果了），
 * 它失败绝不能影响截图入库本身。所以这里所有路径都返回结果对象而不是抛错。
 *
 * 三种模式：
 *   off   —— 不写总结
 *   rules —— 本地抽取式：从 OCR 文字里挑出最有信息量的句子（免费、瞬时、质量一般）
 *   host  —— 交给宿主文本模型写一句人话（花钱很少，质量好很多），失败自动降级到 rules
 */
import { streamText, pickReasoningEffort } from './ocr.mjs';

export const SUMMARY_MODES = ['off', 'rules', 'host'];

const SUMMARY_PROMPT = [
  '你在给一张手机截图写一句话摘要，用途是以后翻相册时能一眼想起这张图是什么。',
  '',
  '要求：',
  '1. 只输出摘要本身，不要任何前缀、解释、引号或 markdown。',
  '2. 一句话，30 到 60 个汉字。',
  '3. 说清楚「这是什么内容」，不要复述文字，不要评价。',
  '4. 如果文字是题目，说明考的是什么知识点；如果是聊天，说明在聊什么事；',
  '   如果是文章/段子，说出它的主题；如果是文档票据，说明是什么单据。',
  '5. 文字是乱码或信息不足时，只输出「内容不明确」。',
].join('\n');

/**
 * 本地抽取式摘要：挑信息量最大的那句，再不行就截断。
 * 判据很土但有效：优先带数字/标点完整的句子，其次是最长的一句。
 */
export function extractiveSummary(text, maxChars = 120) {
  const clean = String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (!clean) return '';

  // 先按句末标点切，保留分隔符
  const parts = clean
    .split(/(?<=[。！？!?；;])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);

  const pool = parts.length ? parts : [clean];

  // 打分：有数字 +1，含中文 ≥8 字 +1，长度适中 +1
  let best = pool[0];
  let bestScore = -1;
  for (const s of pool) {
    let score = 0;
    if (/\d/.test(s)) score += 1;
    if (/[\u4e00-\u9fa5]{8,}/.test(s)) score += 1;
    if (s.length >= 10 && s.length <= 80) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }

  const flat = best.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars - 1)}…`;
}

/** 选一个能用的文本路由：配置里指定的 → 宿主默认 → 第一个 provider 的第一个模型 */
async function resolveTextRoute(config, llm, host) {
  if (!llm || typeof llm.stream !== 'function') return null;

  const preferred = String(config?.summarizeModel || '').trim();
  const providers = (() => {
    try {
      return (llm.listProviders?.() || []).map((p) => p.id).filter(Boolean);
    } catch {
      return [];
    }
  })();

  const tryModel = async (provider, model) => {
    if (!provider || !model) return null;
    try {
      const models = await llm.listModels(provider);
      if (Array.isArray(models) && models.some((m) => m.id === model)) return { provider, model };
    } catch {
      return { provider, model }; // 目录查不到就放行，让真实请求报错
    }
    return null;
  };

  // 1) 配置里写死的，支持 "provider/model" 或裸 model id
  if (preferred) {
    if (preferred.includes('/')) {
      const [p, ...rest] = preferred.split('/');
      const hit = await tryModel(p, rest.join('/'));
      if (hit) return hit;
    } else {
      for (const p of providers) {
        const hit = await tryModel(p, preferred);
        if (hit) return hit;
      }
    }
  }

  // 2) 宿主当前默认模型
  try {
    const sel = host?.agentDefaultModel?.currentSelection?.();
    if (sel?.provider && sel?.model) {
      const hit = await tryModel(sel.provider, sel.model);
      if (hit) return hit;
    }
  } catch {
    /* 默认模型服务可能没装，继续往下试 */
  }

  // 3) 各 provider 的第一个模型
  for (const p of providers) {
    try {
      const models = await llm.listModels(p);
      const first = Array.isArray(models) ? models.find((m) => m && m.id) : null;
      if (first) return { provider: p, model: first.id };
    } catch {
      /* 这个 provider 的目录不可用，换下一个 */
    }
  }

  return null;
}

/**
 * 走宿主文本模型写摘要。
 * 只喂 OCR 文字，不喂图片 —— 图片 OCR 已经看过一遍了，再看一遍是白花钱。
 */
async function summarizeWithHost(config, text, host) {
  const llm = host?.llm;
  const route = await resolveTextRoute(config, llm, host);
  if (!route) throw new Error('没有可用的文本模型');

  const effort = await pickReasoningEffort(llm, route);
  const clipped = String(text).slice(0, 1500);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  timer.unref?.();

  try {
    const raw = await streamText(llm, {
      provider: route.provider,
      model: route.model,
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: `截图里的文字：\n${clipped}` },
      ],
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      maxTokens: 400,
      signal: controller.signal,
    });
    return normalizeSummary(raw);
  } finally {
    clearTimeout(timer);
  }
}

/** 模型有时会自作多情加引号/换行/前缀，这里统一清理 */
export function normalizeSummary(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  // 去掉包裹的引号与 markdown 强调
  s = s.replace(/^["'“”「」『』*]+/u, '').replace(/["'“”「」『』*]+$/u, '');
  // 只取第一段
  s = s.split(/\n{2,}/)[0].replace(/\s*\n\s*/g, ' ').trim();
  // 去掉常见前缀
  s = s.replace(/^(摘要|总结|这是一张|这张图)[:：]\s*/u, '').trim();
  if (s.length > 200) s = `${s.slice(0, 199)}…`;
  return s;
}

/**
 * 统一入口。永不抛错。
 *
 * @returns {{summary: string, via: 'off'|'rules'|'host', error?: string}}
 */
export async function summarizeOcr(config, text, host = {}) {
  const mode = String(config?.summarizeMode || 'rules');
  const clean = String(text || '').trim();

  if (mode === 'off') return { summary: '', via: 'off' };
  if (!clean) return { summary: '', via: 'rules' };
  // 「识别失败:...」这种占位文字不值得总结
  if (/^（识别失败[:：]/.test(clean)) return { summary: '', via: 'rules' };

  const maxChars = Number(config?.summarizeMaxChars) > 0 ? Number(config.summarizeMaxChars) : 120;

  // 摘要跟原文一字不差时不要写 —— 那不是摘要,是把 OCR 抄了第二遍。
  // 单句 OCR（比如一句话的新闻、一张单据）必然走到这里:抽取式挑的就是那句原文。
  // 与其在笔记里留两行一样的字，不如承认这段文字没有可压缩的信息。
  const sameAsSource = (s) => squash(s) === squash(clean);
  const finish = (s, via, error) => (sameAsSource(s) ? { summary: '', via, ...(error ? { error } : {}) } : { summary: s, via, ...(error ? { error } : {}) });

  if (mode === 'rules') {
    return finish(extractiveSummary(clean, maxChars), 'rules');
  }

  // mode === 'host'
  try {
    const s = await summarizeWithHost(config, clean, host);
    if (s) return finish(s, 'host');
    return finish(extractiveSummary(clean, maxChars), 'rules', '模型返回空摘要');
  } catch (err) {
    host?.logger?.warn?.(`dsh-screenshot-classify: 摘要生成失败,已降级到本地抽取(${err?.message || err})`);
    return finish(extractiveSummary(clean, maxChars), 'rules', String(err?.message || err));
  }
}

/** 只保留实义字符，用来判「两段文字是不是同一段」 */
function squash(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[。！？；,，.!?;:：、"'“”「」『』]/g, '');
}
