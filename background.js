// ============================================================================
// CC98 AI 总结 - Service Worker
// 职责：令牌校验 / 搜索 / 限速爬取 / UBB 清洗 / 调用 DeepSeek 总结
// ============================================================================

const API_BASE = "https://api.cc98.org";
const SETTINGS_KEY = "cc98_ai_settings";

const DEFAULTS = {
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-chat",
    temperature: 0.3,
    maxTokens: 2000
  },
  rate: {
    baseDelayMs: 3000, // 每个帖子内部的翻页间隔
    jitterMs: 3000,    // 随机抖动上限（实际等待 = base + rand(0, jitter)）
    concurrency: 2,    // 同时抓取的帖子数（像多开标签页）
    globalSpacingMs: 250, // 全局请求最小间隔，防止并发请求同刻打出
    sizePerPage: 30,   // 每页楼层数（API 上限 30，越大请求越少越快）
    maxPages: 5,       // 每帖最多翻页数
    maxTotalChars: 60000, // 喂给 AI 的总字符上限
    maxRetries: 3      // 触发限流时的最大重试次数
  },
  cc98Token: "",
  cc98Name: ""
};

let settings = structuredClone(DEFAULTS);
let running = false;
let stopRequested = false;
let activeTabId = null;
let lastRequestAt = 0; // 全局请求节拍（毫秒时间戳）

// 会话（材料 + 历史）同时落到 storage.session，避免 MV3 SW 重启后丢失
const SESSION_KV = "cc98_ai_sessions";
let sessions = new Map(); // sid -> { topic, material, history }

async function loadSessions() {
  try {
    const got = await chrome.storage.session.get(SESSION_KV);
    const raw = got[SESSION_KV];
    if (raw) sessions = new Map(Object.entries(raw));
  } catch (e) { sessions = new Map(); }
}
async function persistSessions() {
  try {
    await chrome.storage.session.set({
      [SESSION_KV]: Object.fromEntries(sessions)
    });
  } catch (e) { /* 超出配额等场景静默忽略 */ }
}

init();

async function init() {
  await loadSettings();
  await loadSessions();

  // 被动捕获登录令牌：观察页面发往 api.cc98.org 的请求头（只读，不拦截不修改）
  chrome.webRequest.onBeforeSendHeaders.addListener(
    captureTokenFromHeaders,
    { urls: ["*://api.cc98.org/*"] },
    ["requestHeaders", "extraHeaders"]
  );

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handleMessage(msg, sender)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e && e.message ? e.message : String(e) }));
    return true; // 异步 sendResponse
  });
}

// ---------------------------------------------------------------------------
// 令牌被动捕获：页面(SAP)发请求时自动带上 Bearer，从这里读取并校验
// ---------------------------------------------------------------------------
let lastTokenCheck = 0;

async function captureTokenFromHeaders(details) {
  try {
    const headers = details.requestHeaders;
    if (!headers) return;
    const auth = headers.find((h) => h.name.toLowerCase() === "authorization");
    if (!auth || !auth.value) return;
    const m = /^Bearer\s+(.+)$/i.exec(auth.value);
    if (!m || !m[1].trim()) return;
    const token = m[1].trim();
    if (token === settings.cc98Token) return; // 和已存令牌相同则跳过
    // 节流：校验请求最多每 30s 一次
    const now = Date.now();
    if (now - lastTokenCheck < 30000) return;
    lastTokenCheck = now;
    const name = await verifyToken(token);
    if (name) {
      settings.cc98Token = token;
      settings.cc98Name = name;
      await saveSettings();
    }
  } catch (e) {
    /* 捕获失败静默处理，不影响浏览 */
  }
}

// ---------------------------------------------------------------------------
// 设置读写
// ---------------------------------------------------------------------------
function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over || {})) {
    const ov = over[k];
    const bv = out[k];
    if (ov && typeof ov === "object" && !Array.isArray(ov) && bv && typeof bv === "object" && !Array.isArray(bv)) {
      out[k] = deepMerge(bv, ov);
    } else if (ov !== undefined) {
      out[k] = ov;
    }
  }
  return out;
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settings = deepMerge(structuredClone(DEFAULTS), stored[SETTINGS_KEY] || {});
}

async function saveSettings() {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// ---------------------------------------------------------------------------
// 消息分发
// ---------------------------------------------------------------------------
async function handleMessage(msg, sender) {
  switch (msg.type) {
    case "GET_STATE":
      return getState();

    case "SETTINGS": {
      const prevToken = settings.cc98Token;
      settings = deepMerge(settings, msg.patch || {});
      // 手动填入新令牌时验证一次并记录用户名
      if (msg.patch && msg.patch.cc98Token && msg.patch.cc98Token !== prevToken) {
        const name = await verifyToken(msg.patch.cc98Token);
        settings.cc98Name = name || "";
        settings.cc98Token = name ? msg.patch.cc98Token : "";
        await saveSettings();
        return getState();
      }
      await saveSettings();
      return getState();
    }

    case "SET_TOKEN": {
      const candidates = Array.isArray(msg.candidates) ? msg.candidates : [];
      const found = await tryCandidates(candidates);
      if (found) {
        settings.cc98Token = found.token;
        settings.cc98Name = found.name;
        await saveSettings();
        return { ok: true, name: found.name };
      }
      return { ok: false, error: "未找到有效的登录令牌" };
    }

    case "START_SUMMARIZE": {
      const topic = String(msg.topic || "").trim();
      const items = Array.isArray(msg.items) ? msg.items : [];
      if (!topic) return { error: "请输入总结主题" };
      if (!items.length) return { error: "请先勾选要总结的帖子" };
      if (running) return { error: "已有任务在运行中" };
      activeTabId = sender.tab ? sender.tab.id : null;
      // 后台异步执行，进度通过 tabs.sendMessage 推回
      summarize(topic, items, activeTabId);
      return { started: true };
    }

    case "STOP":
      stopRequested = true;
      return { ok: true };

    // 追问：使用该 session 已抓取的材料 + 累计对话历史（记忆上文与材料）
    case "FOLLOWUP": {
      const s = sessions.get(String(msg.sessionId || ""));
      const question = String(msg.question || "").trim();
      if (!s) return { error: "会话不存在或已失效，请重新总结" };
      if (!question) return { error: "请输入问题" };
      if (running) return { error: "已有任务在运行中" };
      running = true;
      stopRequested = false;
      activeTabId = sender.tab ? sender.tab.id : null;
      followup(s, question, activeTabId);
      return { started: true };
    }

    default:
      return { error: "未知消息类型: " + msg.type };
  }
}

function getState() {
  return {
    running,
    tokenSet: !!settings.cc98Token,
    cc98Name: settings.cc98Name,
    deepseekConfigured: !!settings.deepseek.apiKey,
    settings
  };
}

// ---------------------------------------------------------------------------
// 令牌：验证候选（来自页面 localStorage / cookie 的自动检测）
// ---------------------------------------------------------------------------
async function tryCandidates(candidates) {
  const seen = new Set();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    const name = await verifyToken(c);
    if (name) return { token: c, name };
  }
  return null;
}

async function verifyToken(token) {
  try {
    const r = await fetch(`${API_BASE}/me`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (r.ok) {
      const me = await r.json();
      return me && (me.name || me.id) ? String(me.name || me.id) : "已登录";
    }
  } catch (e) {
    /* 网络失败忽略，继续试下一个 */
  }
  return null;
}

// ---------------------------------------------------------------------------
// 主流程：限速爬取 + 流式总结；并建立会话供追问使用
// ---------------------------------------------------------------------------
async function summarize(topic, items, tabId) {
  running = true;
  stopRequested = false;
  const perTopic = new Array(items.length);
  const concurrency = clamp(settings.rate.concurrency || 1, 1, Math.max(1, items.length));
  let next = 0;
  let done = 0;

  const runWorker = async () => {
    while (true) {
      if (stopRequested) throw new Error("已停止");
      const idx = next++;
      if (idx >= items.length) break;
      const it = items[idx];
      send(tabId, {
        type: "PROGRESS",
        phase: "crawl",
        current: done,
        total: items.length,
        message: `正在抓取「${it.title}」…`,
        percent: Math.round((done / items.length) * 70)
      });

      const text = await crawlTopic(it.id, it.title);
      perTopic[idx] = { title: it.title || ("帖子 #" + it.id), text };
      done++;

      send(tabId, {
        type: "PROGRESS",
        phase: "crawl",
        current: done,
        total: items.length,
        message: `完成「${it.title}」（${text.length} 字）`,
        percent: Math.round((done / items.length) * 70)
      });
    }
  };

  try {
    // 并发抓取多个帖子；每个帖子内部仍串行 + 慢速翻页
    await Promise.all(
      Array.from({ length: concurrency }, () => runWorker())
    );

    let material = perTopic
      .map((p) => `### ${p.title}\n${p.text}`)
      .join("\n\n");
    if (material.length > settings.rate.maxTotalChars) {
      material = material.slice(0, settings.rate.maxTotalChars) + "\n\n…（内容过长已截断）";
    }

    // 建立会话（保存材料 + 空历史），供后续追问复用
    const sid = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const session = { topic, material, history: [] };
    sessions.set(sid, session);
    await persistSessions();

    send(tabId, {
      type: "PROGRESS",
      phase: "ai",
      message: "DeepSeek 生成中…",
      percent: 85
    });

    const summary = await streamChatToPage(session, tabId, true);
    // 记录首轮问答作为上下文，供后续追问记忆
    session.history.push({ role: "user", content: `请总结：${topic}` });
    session.history.push({ role: "assistant", content: summary });
    await persistSessions();

    send(tabId, {
      type: "RESULT",
      topic,
      count: items.length,
      summary,
      sessionId: sid
    });
  } catch (e) {
    send(tabId, { type: "ERROR", message: e && e.message ? e.message : String(e) });
  } finally {
    running = false;
    activeTabId = null;
  }
}

// 追问单个开场
async function followup(session, question, tabId) {
  try {
    session.history.push({ role: "user", content: question });
    await persistSessions();
    const answer = await streamChatToPage(session, tabId, false);
    session.history.push({ role: "assistant", content: answer });
    await persistSessions();
    send(tabId, { type: "FOLLOWUP_DONE" });
  } catch (e) {
    session.history.pop(); // 回滚失败提问，保持历史一致
    await persistSessions();
    send(tabId, { type: "ERROR", message: e && e.message ? e.message : String(e) });
  } finally {
    running = false;
    activeTabId = null;
  }
}

// 依据 session 的材料 + 历史调用流式接口，并把增量(缓冲合并)推到页面
async function streamChatToPage(session, tabId, isFirst) {
  const messages = [];
  const history = session.history;

  // 填系统题外单上下文：材料始终在系统里，历史 Q/A 轮流追加
  const materialBlock = history.length
    ? [
        `以下是已抓取的 CC98 帖子原文材料（只读，作为一切回答的依据，回答须完全基于它，不得编造）：`,
        session.material
      ].join("\n")
    : session.material;

  let system;
  if (history.length) {
    system =
      "你是浙大 CC98 论坛内容分析助手。全程依据下面给出的「帖子材料」问答。" +
      "要求：完全基于材料，不得编造材料之外的事实；只聚焦会话主题，无关内容忽略；" +
      "精炼、无废话，直接答要点；标注楼层时注明（如“3楼”）。以下为材料：\n" + materialBlock;
  } else {
    system =
      "你是浙大 CC98 论坛内容分析助手。硬性要求：精炼、信息密度高、杜绝废话——不要开场白、客套话、免责声明，不要复述问题，输出使用 Markdown。";
  }

  messages.push({ role: "system", content: system });
  if (!history.length) {
    messages.push({ role: "user", content: buildPrompt(session.topic, session.material) });
  } else {
    // 追问阶段：把历史问答带上（除最后一次已 push 的 user，其作为本次问题）
    for (const h of history) messages.push({ role: h.role, content: h.content });
  }

  const full = await callDeepseek(messages);

  if (isFirst) {
    // result delivered by caller
  }
  return full;
}

async function crawlTopic(id, fallbackTitle) {
  const token = await ensureToken();
  const title = fallbackTitle || ("帖子 #" + id);

  const size = clamp(settings.rate.sizePerPage, 1, 30);
  const maxPages = settings.rate.maxPages;
  const chunks = [];

  for (let page = 0; page < maxPages; page++) {
    if (stopRequested) throw new Error("已停止");
    // 每个帖子内部翻页仍保持"人读帖"节奏
    await rateDelay();

    const from = page * size;
    const posts = await apiGet(
      `${API_BASE}/Topic/${id}/post?from=${from}&size=${size}`,
      token
    );
    if (!Array.isArray(posts) || !posts.length) break;

    for (const p of posts) {
      if (p.isDeleted) {
        chunks.push(`【${p.floor}楼】（内容已删除）`);
        continue;
      }
      const content = ubbToText(String(p.content || ""));
      if (!content) continue;
      const author = p.isAnonymous ? "(匿名)" : (p.userName || "匿名");
      chunks.push(`【${p.floor}楼 · ${author}】\n${content}`);
    }

    if (posts.length < size) break;
  }

  if (!chunks.length) return `（「${title}」暂无可见内容）`;
  return `标题：${title}\n\n` + chunks.join("\n\n");
}

// ---------------------------------------------------------------------------
// 带限速 + 退避的 API 请求
// ---------------------------------------------------------------------------
async function apiGet(url, token) {
  // 全局最小间隔：并发抓取时仍避免多个请求同刻打出
  await paceGlobal();

  let attempt = 0;
  let backoff = 10000;

  while (true) {
    if (stopRequested) throw new Error("已停止");
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${token}` }
    });

    if (r.ok) return await r.json();

    if (r.status === 401) {
      throw new Error("登录令牌已失效，请刷新 cc98 页面后重试（插件会自动重新获取）");
    }

    // 限流 / 拒绝 / 服务器错误 → 指数退避重试
    if (r.status === 429 || r.status === 403 || r.status >= 500) {
      attempt++;
      if (attempt > settings.rate.maxRetries) {
        throw new Error(
          `连续被限流（HTTP ${r.status}），已自动暂停以保护账号。请增大抓取间隔或稍后再试。`
        );
      }
      const wait = backoff + Math.random() * 5000;
      backoff *= 2;
      await sleep(wait);
      continue;
    }

    const text = await r.text().catch(() => "");
    throw new Error(`CC98 API ${r.status}: ${text.slice(0, 200)}`);
  }
}

async function ensureToken() {
  if (!settings.cc98Token) {
    throw new Error("未获取到 CC98 登录令牌。请确保已在 cc98.org 登录，并打开任意 cc98 页面让插件自动获取。");
  }
  return settings.cc98Token;
}

// ---------------------------------------------------------------------------
// DeepSeek（SSE 流式，消息数组入参），缓冲转发到页面（打字机效果）
// ---------------------------------------------------------------------------
const PAGE_FLUSH_INTERVAL = 80; // ms

async function callDeepseek(messages) {
  const ds = settings.deepseek;
  if (!ds.apiKey) throw new Error("未配置 DeepSeek API Key，请在扩展「选项」页填写。");

  const base = String(ds.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ds.apiKey}`
    },
    body: JSON.stringify({
      model: ds.model,
      messages,
      temperature: Number(ds.temperature) || 0.3,
      max_tokens: Number(ds.maxTokens) || 2000,
      stream: true
    })
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`DeepSeek 调用失败 ${r.status}: ${t.slice(0, 300)}`);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  let pageBuf = "";
  let flushTimer = null;
  const tabId = activeTabId;

  const doFlush = () => {
    if (pageBuf) {
      send(tabId, { type: "STREAM_DELTA", delta: pageBuf });
      pageBuf = "";
    }
  };
  const schedule = () => {
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        doFlush();
      }, PAGE_FLUSH_INTERVAL);
    }
  };

  while (true) {
    if (stopRequested) {
      try { await reader.cancel(); } catch (e) { /* 忽略 */ }
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      doFlush();
      throw new Error("已停止");
    }
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const delta =
          j.choices && j.choices[0] && j.choices[0].delta &&
          typeof j.choices[0].delta.content === "string"
            ? j.choices[0].delta.content
            : "";
        if (delta) {
          full += delta;
          pageBuf += delta;
          schedule();
        }
      } catch (e) { /* 跳过无法解析的行 */ }
    }
  }

  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  doFlush();

  return full || "(空结果)";
}

function buildPrompt(topic, content) {
  return [
    `请围绕主题【${topic}】对以下 CC98 论坛帖子内容进行总结分析。`,
    `要求（务必遵守）：`,
    `1. 严格围绕主题：只提炼与【${topic}】直接相关的内容，与主题无关的楼层/内容一律忽略，不引入材料外的任何话题；`,
    `2. 完全基于材料：只能依据下方实际出现的帖子内容，不得编造或补充材料之外的任何事实、数据、姓名、例子；材料不足以支撑某点时，明确写“材料中未涉及”；`,
    `3. 精炼去废话：不客套、不空话，每句话都要有信息量；`,
    `4. 直接分点输出：核心观点 → 不同立场与分歧 → 结论/建议；`,
    `5. 引用具体楼层时标注来源（如“3楼”）；`,
    `6. 用 Markdown（小标题 + 短列表），整体宜短不宜长。`,
    ``,
    `帖子内容：`,
    content
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function rateDelay() {
  const { baseDelayMs, jitterMs } = settings.rate;
  return sleep((baseDelayMs || 0) + Math.random() * (jitterMs || 0));
}

// 全局节拍：保证任意两次请求之间至少有 globalSpacingMs 的间隔
function paceGlobal() {
  const now = Date.now();
  const gap = settings.rate.globalSpacingMs || 0;
  const target = lastRequestAt + gap;
  lastRequestAt = Math.max(now, target);
  const wait = lastRequestAt - now;
  return wait > 0 ? sleep(wait) : Promise.resolve();
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function send(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

// UBB → 纯文本（适配自 cc98-mcp，MIT）
function ubbToText(content) {
  let text = String(content || "");

  text = text.replace(/\[img\]([\s\S]*?)\[\/img\]/gi, "[图片: $1]");
  text = text.replace(/\[video\]([\s\S]*?)\[\/video\]/gi, "[视频: $1]");
  text = text.replace(/\[audio\]([\s\S]*?)\[\/audio\]/gi, "[音频: $1]");
  text = text.replace(/\[upload(?:=[^\]]*)?\]([\s\S]*?)\[\/upload\]/gi, "[文件: $1]");
  text = text.replace(/\[upload(?:=[^\]]*)?\](https?:\/\/\S+)/gi, "[文件: $1]");

  text = text.replace(/\[url=([^\]]*)\]([\s\S]*?)\[\/url\]/gi, "$2 ($1)");
  text = text.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, "$1");

  text = text.replace(/\[quote\]/gi, "\n> [引用] ");
  text = text.replace(/\[\/quote\]/gi, "\n");

  text = text.replace(/\[\/?(b|i|u|del|center|left|right|line|noubb)\]/gi, "");
  text = text.replace(/\[(color|size|font|align|bg|sound|upload)=[^\]]*\]/gi, "");
  text = text.replace(/\[\/(color|size|font|align|bg|sound|upload)\]/gi, "");
  text = text.replace(/\[(ac|em|cc98|tb|ms)\d+\]/gi, "[表情]");

  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text;
}
