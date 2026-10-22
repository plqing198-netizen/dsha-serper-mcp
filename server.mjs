#!/usr/bin/env node
/**
 * dsh-serper-mcp — Serper (Google Search API) MCP server for DSH
 *
 * 零依赖实现：仅用 Node 内置模块 + 全局 fetch。
 * 传输层：stdio，消息帧为换行分隔的 JSON-RPC 2.0（NDJSON）。
 *
 * 设计要点：
 *  - stdout 只输出协议消息；所有日志走 stderr（否则会污染协议流）。
 *  - 密钥从环境变量 SERPER_API_KEY 读取。DSH 的 stdio 子进程会清洗掉名字含
 *    KEY/TOKEN/SECRET/PASSWORD 的变量，所以必须在 cordis.patch.yml 的 env: 里显式传。
 *  - 缺密钥时不崩溃：initialize / tools/list 正常返回，工具调用返回可读错误，
 *    便于模型自行判断（与 dsh-tool-web 的处理方式一致）。
 */

import process from 'node:process';

// ---------------------------------------------------------------- 配置

const API_KEY = (process.env.SERPER_API_KEY ?? '').trim();
const SERP_BASE = 'https://google.serper.dev';
const SCRAPE_ENDPOINT = 'https://scrape.serper.dev';
const REQUEST_TIMEOUT_MS = clampInt(process.env.SERPER_TIMEOUT_MS, 45_000, 1_000, 300_000);
const MAX_TEXT_CHARS = clampInt(process.env.SERPER_MAX_TEXT_CHARS, 120_000, 1_000, 2_000_000);
const SERVER_NAME = 'serper';
const SERVER_VERSION = '1.0.0';
const USER_AGENT = `dsh-serper-mcp/${SERVER_VERSION}`;

/**
 * 我们声明支持的协议版本，从高到低。
 * 协商策略：回退到「不高于客户端请求版本」的最高版本，保证客户端一定接受。
 * 这些版本同时出现在 DSH 客户端 (@modelcontextprotocol/core) 的
 * SUPPORTED_PROTOCOL_VERSIONS 中，因此协商结果对 DSH 有效。
 */
const OUR_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];
const FALLBACK_PROTOCOL_VERSION = '2024-11-05';

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function log(...args) {
  process.stderr.write(`[serper-mcp] ${args.join(' ')}\n`);
}

// ---------------------------------------------------------------- 工具定义

/** 各 SERP 端点共用的参数 */
const COMMON_PROPS = {
  gl: {
    type: 'string',
    description: "国家/地区代码（ISO 3166-1 alpha-2），如 'cn'、'us'、'jp'。默认 cn。",
  },
  hl: {
    type: 'string',
    description: "结果语言代码（ISO 639-1），如 'zh-cn'、'en'、'ja'。默认 zh-cn。",
  },
  num: {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    description: '返回结果条数，1-100。默认 10。注意：超过 10 条会消耗 2 个 credit。',
  },
  page: {
    type: 'integer',
    minimum: 1,
    maximum: 10,
    description: '结果页码，默认 1。用于翻页。',
  },
  location: {
    type: 'string',
    description: "地理位置过滤，如 'Shanghai, China'。可选。",
  },
  tbs: {
    type: 'string',
    description:
      "时间范围过滤。常用值：qdr:h(过去1小时) qdr:d(过去1天) qdr:w(过去1周) qdr:m(过去1月) qdr:y(过去1年)。可选。",
  },
};

/**
 * 各端点返回主结果数组所用的字段名。
 *
 * 为什么需要它：Serper 只有 /search 和 /images 真正遵守 num 参数，其余端点会忽略它
 * 并返回固定条数（实测：news 固定 13、videos/scholar/patents/places 固定 10、
 * shopping 固定 40）。因此在本地按 num 截断，使参数的实际行为与描述一致。
 */
function serpTool(name, endpoint, description, arrayKey, extraProps = {}, requiredExtra = []) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: '搜索关键词。' }, ...COMMON_PROPS, ...extraProps },
      required: ['q', ...requiredExtra],
      additionalProperties: false,
    },
    __endpoint: endpoint,
    __arrayKey: arrayKey,
  };
}

const TOOLS = [
  serpTool(
    'serper_search',
    '/search',
    '用 Google 搜索网页，返回自然结果、知识图谱(knowledgeGraph)、相关提问(peopleAlsoAsk)、相关搜索等结构化数据。适合一般性资料检索。',
    'organic',
  ),
  serpTool(
    'serper_news',
    '/news',
    '用 Google News 搜索新闻报道，适合获取时效性信息。建议配合 tbs 限定时间范围。',
    'news',
  ),
  serpTool(
    'serper_images',
    '/images',
    '用 Google 搜索图片，返回图片链接、缩略图、尺寸等元信息。',
    'images',
  ),
  serpTool(
    'serper_videos',
    '/videos',
    '用 Google 搜索视频，返回视频标题、链接、来源平台、时长等。',
    'videos',
  ),
  serpTool(
    'serper_places',
    '/places',
    '搜索本地的商家/地点（Google Maps 数据），返回名称、地址、评分、经纬度、类别、营业时间等。适合找店铺、餐馆、机构。',
    'places',
  ),
  serpTool(
    'serper_scholar',
    '/scholar',
    '用 Google Scholar 搜索学术文献，返回论文标题、作者、期刊、年份、引用数、PDF 链接等。适合做学术调研。',
    'organic',
  ),
  serpTool(
    'serper_patents',
    '/patents',
    '用 Google Patents 搜索专利，返回专利号、标题、申请人、发明人、优先权日、链接等。',
    'organic',
  ),
  serpTool(
    'serper_shopping',
    '/shopping',
    '用 Google Shopping 搜索商品，返回商品名、价格、商家、评分、购买链接等。',
    'shopping',
  ),
  serpTool(
    'serper_autocomplete',
    '/autocomplete',
    '获取 Google 搜索自动补全建议词。适合做关键词扩展、搜索意图探索。',
    'suggestions',
    {},
    [],
  ),
  {
    name: 'serper_scrape',
    description:
      '抓取指定网页并提取正文内容（返回纯文本，可选 Markdown）。适合读取搜索结果里某个页面的完整内容。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的网页 URL，须以 http:// 或 https:// 开头。' },
        includeMarkdown: {
          type: 'boolean',
          description: '是否额外返回 Markdown 格式内容。默认 false。',
          default: false,
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    __endpoint: null, // 走 scrape 端点
  },
];

// ---------------------------------------------------------------- HTTP 调用

class SerperError extends Error {
  constructor(message, { status, detail } = {}) {
    super(message);
    this.name = 'SerperError';
    this.status = status;
    this.detail = detail;
  }
}

async function postJson(url, body) {
  if (!API_KEY) {
    throw new SerperError(
      '缺少 Serper 密钥：环境变量 SERPER_API_KEY 为空。请在 $DSH_HOME/.env 中设置，' +
        '并确认 cordis.patch.yml 的 mcp-serper 条目在 env: 里显式传递了 SERPER_API_KEY。',
    );
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-API-KEY': API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? `请求超时（${REQUEST_TIMEOUT_MS}ms）` : String(err?.message ?? err);
    throw new SerperError(`调用 Serper 失败：${reason}`);
  }

  const raw = await res.text();

  if (!res.ok) {
    let detail = raw.slice(0, 500);
    try {
      const parsed = JSON.parse(raw);
      detail = parsed?.message ?? parsed?.error ?? detail;
    } catch {
      /* 保留原始文本 */
    }
    const hint =
      res.status === 401 || res.status === 403
        ? '（密钥无效或权限不足）'
        : res.status === 429
          ? '（触发限流或额度耗尽）'
          : '';
    throw new SerperError(`Serper 返回 HTTP ${res.status}${hint}：${detail}`, { status: res.status, detail });
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new SerperError(`Serper 返回了无法解析的响应（前 300 字符）：${raw.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------- 参数整形

/**
 * 把模型传来的参数整理成 Serper 接受的 body，并剔除 undefined/null。
 * 同时把规范化后的 num 一并返回，供本地截断使用。
 */
function buildSerpBody(args) {
  const body = {};
  const q = typeof args?.q === 'string' ? args.q.trim() : '';
  if (!q) throw new SerperError('参数 q（搜索关键词）不能为空。');
  body.q = q;

  body.gl = nonEmptyString(args?.gl) ?? 'cn';
  body.hl = nonEmptyString(args?.hl) ?? 'zh-cn';

  let num;
  const rawNum = toInt(args?.num);
  if (rawNum !== undefined) {
    num = Math.min(Math.max(rawNum, 1), 100);
    body.num = num;
  }

  const page = toInt(args?.page);
  if (page !== undefined && page > 1) body.page = Math.min(Math.max(page, 1), 10);

  const location = nonEmptyString(args?.location);
  if (location) body.location = location;

  const tbs = nonEmptyString(args?.tbs);
  if (tbs) body.tbs = tbs;

  return { body, num };
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function toInt(v) {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function truncate(obj) {
  const text = JSON.stringify(obj, null, 2);
  if (text.length <= MAX_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TEXT_CHARS)}\n\n…（输出已截断，原始长度 ${text.length} 字符）`;
}

/**
 * 按 num 截断主结果数组。
 *
 * Serper 只有 /search 和 /images 遵守 num，其余端点会返回固定条数。
 * 这里统一裁到 num，保证「请求几条就得到几条」（不超出端点自身的返回上限）。
 * 同时把截断事实写进结果，避免模型误以为这就是全部结果。
 */
function capArray(data, arrayKey, num) {
  if (!arrayKey || num === undefined) return data;
  const arr = data?.[arrayKey];
  if (!Array.isArray(arr) || arr.length <= num) return data;

  const capped = { ...data, [arrayKey]: arr.slice(0, num) };
  const dropped = arr.length - num;
  capped.__truncated = {
    note: `该端点不遵守 num 参数，已按请求的 num=${num} 在本地截断。`,
    returned: num,
    dropped,
  };
  return capped;
}

// ---------------------------------------------------------------- 工具执行

async function runTool(name, args) {
  if (name === 'serper_scrape') {
    const url = nonEmptyString(args?.url);
    if (!url) throw new SerperError('参数 url 不能为空。');
    if (!/^https?:\/\//i.test(url)) throw new SerperError('参数 url 必须以 http:// 或 https:// 开头。');

    const body = { url };
    if (args?.includeMarkdown === true) body.includeMarkdown = true;

    const data = await postJson(SCRAPE_ENDPOINT, body);
    return truncate(data);
  }

  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new SerperError(`未知工具：${name}`);
  if (!tool.__endpoint) throw new SerperError(`工具 ${name} 未配置端点。`);

  const { body, num } = buildSerpBody(args);
  const data = await postJson(`${SERP_BASE}${tool.__endpoint}`, body);
  return truncate(capArray(data, tool.__arrayKey, num));
}

// ---------------------------------------------------------------- JSON-RPC 协议层

function negotiateVersion(requested) {
  const want = typeof requested === 'string' ? requested : '';
  // 严格版本比较：取「不高于客户端请求」的最高受支持版本
  for (const v of OUR_PROTOCOL_VERSIONS) {
    if (v <= want) return v;
  }
  return FALLBACK_PROTOCOL_VERSION;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: '2.0', id, error });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize': {
      const version = negotiateVersion(params?.protocolVersion);
      log(`initialize: 客户端请求 ${params?.protocolVersion ?? '(未指定)'} → 协商为 ${version}`);
      sendResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'Serper MCP Server', version: SERVER_VERSION },
      });
      return;
    }

    case 'ping': {
      sendResult(id, {});
      return;
    }

    case 'tools/list': {
      sendResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
      return;
    }

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      try {
        const text = await runTool(toolName, args);
        // 成功：按 MCP 规范返回 content 数组
        sendResult(id, { content: [{ type: 'text', text }], isError: false });
      } catch (err) {
        // 工具级错误：用 isError 结果回报，让模型能看到原因并自行调整
        const message = err instanceof SerperError ? err.message : `执行工具失败：${String(err?.message ?? err)}`;
        log(`tools/call ${toolName} 失败: ${message}`);
        sendResult(id, { content: [{ type: 'text', text: message }], isError: true });
      }
      return;
    }

    // 我们未声明 resources / prompts 能力，但明确回空列表比报错更友好
    case 'resources/list': {
      sendResult(id, { resources: [] });
      return;
    }
    case 'resources/templates/list': {
      sendResult(id, { resourceTemplates: [] });
      return;
    }
    case 'prompts/list': {
      sendResult(id, { prompts: [] });
      return;
    }

    default: {
      sendError(id, -32601, `Method not found: ${method}`);
    }
  }
}

/** 在途请求，用于 stdin 关闭时优雅收尾，避免异步调用被进程退出打断 */
const inFlight = new Set();

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  // 通知（无 id）：不得回复
  if (msg.id === undefined || msg.id === null) {
    if (msg.method === 'notifications/initialized') log('客户端已初始化');
    return;
  }

  const task = handleRequest(msg).catch((err) => {
    log(`处理 ${msg.method} 时发生未捕获错误: ${String(err?.stack ?? err)}`);
    sendError(msg.id, -32603, `Internal error: ${String(err?.message ?? err)}`);
  });
  inFlight.add(task);
  task.finally(() => inFlight.delete(task));
}

// ---------------------------------------------------------------- stdio 主循环

let buffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch (err) {
      log(`无法解析的消息（已忽略）: ${line.slice(0, 200)} — ${String(err?.message ?? err)}`);
    }
  }
});

// stdin 关闭（客户端结束会话）时，等在途请求写完后才退出，
// 否则最后几个异步工具调用会随进程一起被丢弃。
process.stdin.on('end', () => {
  void Promise.allSettled([...inFlight]).then(() => process.exit(0));
});
process.stdin.on('error', (err) => {
  log(`stdin 错误: ${String(err?.message ?? err)}`);
  process.exit(1);
});

if (!API_KEY) {
  log('警告：SERPER_API_KEY 未设置，工具将返回错误信息。');
}
log(`已启动 v${SERVER_VERSION}，提供 ${TOOLS.length} 个工具。`);
