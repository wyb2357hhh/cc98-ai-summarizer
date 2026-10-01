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
    baseDelayMs: 1500, // 每个帖子内部的翻页间隔
    jitterMs: 1500,    // 随机抖动上限（实际等待 = base + rand(0, jitter)）
    concurrency: 3,    // 同时抓取的帖子数（像多开标签页）
    globalSpacingMs: 150, // 全局请求最小间隔，防止并发请求同刻打出
    searchMinIntervalMs: 5000, // 搜索接口限流：每 5 秒最多搜一次
    sizePerPage: 20,   // 每页楼层数（cc98 上限较小，用 20）
    maxPages: 5,       // 每帖最多翻页数
    maxTotalChars: 60000, // 喂给 AI 的总字符上限
    maxRetries: 3      // 触发限流时的最大重试次数
  },
  search: {
    topK: 8,           // 抓取前 K 篇内容供 AI 合成答案
    maxCandidates: 40  // 多关键词合并后最多保留的候选数
  },
  debug: false,        // 调试模式：在 Service Worker 控制台打印详细日志
  cc98Token: "",
  cc98Name: ""
};

let settings = structuredClone(DEFAULTS);

// 速度参数硬编码：不读存储、不受选项页影响（想要调快/调慢直接改这里）
const RATE = {
  baseDelayMs: 1500,  // 每个帖子内部翻页间隔
  jitterMs: 1500,     // 随机抖动上限
  concurrency: 3,     // 并发抓帖数
  globalSpacingMs: 150, // 全局请求最小间隔
  searchMinIntervalMs: 5000, // 搜索接口限流：每 5 秒最多搜一次（超了会 429）
  sizePerPage: 20,    // 每页楼层数（cc98 上限较小，用 20，超出会 400）
  maxPages: 5,        // 每帖最大翻页数
  maxTotalChars: 60000, // 喂给 AI 的字符上限
  maxRetries: 3       // 限流重试次数
};

let running = false;
let stopRequested = false;
let activeTabId = null;
let lastRequestAt = 0; // 全局请求节拍（毫秒时间戳）
let lastSearchAt = 0;   // 搜索接口节拍（cc98 限流：每 5 秒一次）

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

// MV3 要求：监听器必须在顶层**同步**注册。若放在 await 之后，Service Worker 可能在
// 监听器注册前就被回收，导致 webRequest 令牌捕获失效、消息也收不到。
// 因此这里先同步注册监听器，设置加载改为后台异步完成。
let readyPromise = (async () => {
  await loadSettings();
  await loadSessions();
})();

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

// ---------------------------------------------------------------------------
// 令牌被动捕获：页面(SAP)发请求时自动带上 Bearer，从这里读取并校验
// ---------------------------------------------------------------------------
let lastTriedToken = "";
let lastTryAt = 0;

async function captureTokenFromHeaders(details) {
  await readyPromise; // 等设置加载完成
  try {
    const headers = details.requestHeaders;
    if (!headers) return;
    const auth = headers.find((h) => h.name.toLowerCase() === "authorization");
    if (!auth || !auth.value) return;
    const m = /^Bearer\s+(.+)$/i.exec(auth.value);
    if (!m || !m[1].trim()) return;
    const token = m[1].trim();
    if (token === settings.cc98Token) return; // 已是最新有效令牌（不打印，避免每次请求刷屏）
    log("捕获到新的 Bearer 令牌：", token.slice(0, 16) + "…", "长度", token.length);
    // 同一候选令牌校验失败后 30s 内不重复校验；但新令牌总是立即校验（防止错过刷新后的新令牌）
    const now = Date.now();
    if (token === lastTriedToken && now - lastTryAt < 30000) return;
    lastTriedToken = token;
    lastTryAt = now;
    const name = await verifyToken(token);
    if (name) {
      settings.cc98Token = token;
      settings.cc98Name = name;
      lastTriedToken = "";
      await saveSettings();
      log("令牌验证通过：", name);
    } else {
      log("令牌验证失败（可能已过期）");
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
  settings.rate = { ...RATE }; // 速度参数硬编码，忽略存储值
}

async function saveSettings() {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// ---------------------------------------------------------------------------
// 消息分发
// ---------------------------------------------------------------------------
async function handleMessage(msg, sender) {
  await readyPromise; // 等设置加载完成
  log("收到消息：", msg.type);
  switch (msg.type) {
    case "GET_STATE":
      return getState();

    case "SETTINGS": {
      const prevToken = settings.cc98Token;
      settings = deepMerge(settings, msg.patch || {});
      settings.rate = { ...RATE }; // 速度参数硬编码，忽略选项页提交的 rate
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

    // 问题式搜索：拆关键词 → 官方接口搜索 → 抓 TopK 内容 → AI 合成答案
    case "QUESTION_SEARCH": {
      const question = String(msg.question || "").trim();
      if (!question) return { error: "请输入问题" };
      if (running) return { error: "已有任务在运行中" };
      activeTabId = sender.tab ? sender.tab.id : null;
      running = true;
      stopRequested = false;
      questionSearch(question, activeTabId, msg.topK);
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

// 校验令牌是否可用。
// 注意：/me 需要 openid scope，而论坛 SPA 的令牌常常只有 cc98-api scope，
// 会出现「搜索/帖子接口 200，但 /me 返回 401 invalid_token」的情况。
// 所以 /me 失败时，再用内容接口确认令牌确实可用（能读帖子就够我们用）。
async function verifyToken(token) {
  try {
    const r = await fetch(`${API_BASE}/me`, {
      headers: { authorization: `Bearer ${token}` }
    });
    log("verifyToken /me 状态：", r.status);
    if (r.ok) {
      const me = await r.json();
      return me && (me.name || me.id) ? String(me.name || me.id) : "已登录";
    }
  } catch (e) {
    log("verifyToken /me 网络异常：", e && e.message ? e.message : e);
  }

  // 兜底：用内容接口确认令牌可用（和搜索/读帖同属 cc98-api scope，避开 /me 的 openid scope 限制）
  try {
    const r2 = await fetch(`${API_BASE}/topic/new?from=0&size=1`, {
      headers: { authorization: `Bearer ${token}` }
    });
    log("verifyToken /topic/new 状态：", r2.status);
    if (r2.ok) return "已登录";
  } catch (e) {
    log("verifyToken /topic/new 网络异常：", e && e.message ? e.message : e);
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
      perTopic[idx] = { id: it.id, title: it.title || ("帖子 #" + it.id), text };
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
      .map((p) => `### ${p.title}\n原帖链接：https://www.cc98.org/topic/${p.id}\n${p.text}`)
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
      sessionId: sid,
      refTopics: perTopic.map((p) => ({ id: p.id, title: p.title }))
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
      "精炼、无废话，不要客套话、祝福语和免责声明，不要复述问题；直接答要点；" +
      "标注楼层时注明（如“3楼”），提到某个帖子时给出原帖链接（材料里有），" +
      "格式 [帖子标题](原帖链接)。以下为材料：\n" + materialBlock;
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

// ---------------------------------------------------------------------------
// 问题式搜索：拆关键词 → 官方接口搜索 → 抓 TopK 内容 → AI 合成答案
// ---------------------------------------------------------------------------
async function questionSearch(question, tabId, topKOverride) {
  try {
    log("questionSearch 开始：", question);
    // 抓取帖子数量：面板传入的优先，否则用设置里的默认（1~20）
    const topK = clamp(parseInt(topKOverride, 10) || settings.search.topK || 8, 1, 20);
    log("本次抓取帖子数 topK =", topK);
    // 1. 关键词拆解（弥补 cc98 无模糊搜索）
    sendStage(tabId, 1, 4, "拆解关键词", "正在拆解关键词…", 8);
    const keywords = await generateKeywords(question);
    log("拆解出的关键词：", keywords);
    sendStage(tabId, 1, 4, "拆解关键词", `关键词：${keywords.join("、")}`, 18);

    // 2. 逐个关键词搜索 + 去重合并
    const seen = new Set();
    const topics = [];
    for (let i = 0; i < keywords.length; i++) {
      if (stopRequested) throw new Error("已停止");
      const kw = keywords[i];
      sendStage(tabId, 2, 4, "搜索关键词", `搜索「${kw}」（${i + 1}/${keywords.length}，限流 5s/次）…`, 18 + Math.round((i / keywords.length) * 28));
      const list = await apiSearch(kw);
      log(`关键词「${kw}」命中 ${list.length} 条`);
      for (const t of list) {
        if (!seen.has(t.id)) { seen.add(t.id); t.__kw = kw; topics.push(t); }
      }
      if (topics.length >= settings.search.maxCandidates) break;
    }

    const total = topics.length;
    log("去重后候选数：", total);

    // 0 命中：直接返回，不烧 AI 调用（实测关键词不匹配时会出现）
    if (!total) {
      log("0 命中，跳过 AI 调用");
      sendStage(tabId, 4, 4, "AI 生成答案", "没有搜到相关帖子", 100);
      send(tabId, {
        type: "SEARCH_RESULT",
        question,
        answer: "没有在 CC98 搜到相关帖子。可能是关键词没命中，或论坛里确实没有这类讨论。换个说法（比如用更常见的同义词）再试试。",
        topics: [],
        refTopics: [],
        sessionId: null
      });
      return;
    }
    sendStage(tabId, 3, 4, "读取帖子内容", `共命中 ${total} 篇，读取前 ${topK} 篇…`, 52);

    // 按关键词「轮询」挑选 topK：保证每个关键词都有代表进入材料。
    // 否则高召回的关键词会把名额占满（实测对比型问题里 A 方会把 B 方全挤掉，AI 拿不到双方材料）。
    const buckets = new Map();
    for (const t of topics) {
      const kw = t.__kw || "";
      if (!buckets.has(kw)) buckets.set(kw, []);
      buckets.get(kw).push(t);
    }
    const bucketKeys = [...buckets.keys()];
    const top = [];
    for (let round = 0; top.length < topK && round < 50; round++) {
      let added = false;
      for (const kw of bucketKeys) {
        const b = buckets.get(kw);
        if (round < b.length) {
          top.push(b[round]);
          added = true;
          if (top.length >= topK) break;
        }
      }
      if (!added) break;
    }
    log("轮询选材：候选 %d 条 → 取 %d 条，覆盖关键词 %d 个", topics.length, top.length, bucketKeys.length);
    const material = new Array(top.length);
    const readPool = Math.max(1, Math.min(settings.rate.concurrency || 3, top.length));
    let readNext = 0;
    let readDone = 0;
    const readWorker = async () => {
      while (true) {
        if (stopRequested) throw new Error("已停止");
        const i = readNext++;
        if (i >= top.length) break;
        const t = top[i];
        const text = await crawlTopicShallow(t.id, t.title);
        material[i] = `### ${t.title}（${t.boardName || ""}）\n原帖链接：https://www.cc98.org/topic/${t.id}\n${text}`;
        readDone++;
        sendStage(tabId, 3, 4, "读取帖子内容", `读取 ${readDone}/${top.length} 篇…`, 52 + Math.round((readDone / top.length) * 25));
      }
    };
    await Promise.all(Array.from({ length: readPool }, () => readWorker()));

    const materialText = material.filter(Boolean).join("\n\n");

    // 建立会话，供搜索后继续追问（材料 + 历史）
    const sid = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const session = { topic: question, material: materialText, history: [] };
    sessions.set(sid, session);
    await persistSessions();

    // 4. AI 合成答案（流式到页面）
    sendStage(tabId, 4, 4, "AI 生成答案", "AI 生成答案中…", 85);
    const answer = await callDeepseek(buildSearchMessages(question, material));
    log("搜索完成：答案长度", answer.length, "参考帖", topics.length);

    // 记录首轮问答作为追问上下文
    session.history.push({ role: "user", content: `请回答：${question}` });
    session.history.push({ role: "assistant", content: answer });
    await persistSessions();

    // 5. 返回答案 + 参考帖列表 + 会话 id（refTopics = 实际读过内容的帖子）
    send(tabId, { type: "SEARCH_RESULT", question, answer, topics, refTopics: top, sessionId: sid });
  } catch (e) {
    log("questionSearch 出错：", e && e.message ? e.message : e);
    send(tabId, { type: "ERROR", message: e && e.message ? e.message : String(e) });
  } finally {
    running = false;
    activeTabId = null;
  }
}

// 用 DeepSeek 把问题转成搜索关键词（空格 = 同概念内收窄；并列概念必须分开搜）
async function generateKeywords(question) {
  const system = "你是论坛检索助手。把用户问题转成适合论坛搜索的关键词组合，只输出 JSON 数组。";
  const user = [
    `用户问题：${question}`,
    `请先判断问题类型，再按对应规则输出 3~5 个搜索关键词。`,
    ``,
    `【最重要】论坛搜索是「与」语义：关键词里每多一个空格，就多一个必须同时出现的条件，命中会急剧减少。`,
    `实测（问题：英语四六级对保研的影响）："保研"→20条但大多跑题；"保研 英语"→20条全部切题；`,
    `"保研 英语 要求"→11条质量最高；"保研 英语 要求 六级"→5条且完全是上一组的子集。`,
    `所以：每个关键词用 2~3 个词，最多 3 个词，绝不要 4 个及以上。`,
    ``,
    `【A. 专有名词型】问题围绕某个人名/机构名/课程名/项目名（如"谭德志"）：`,
    `  以它作锚点，输出「锚点 + 限定词」组合（中间一个空格），如：谭德志 实验室、谭德志 导师；`,
    `  并额外给 1 个只有锚点的关键词（谭德志）。稀有专有名词单独搜也很精确，可作兜底。`,
    `  人名必须完整保留，不得改写或拆分。`,
    ``,
    `【B. 对比型】问题是"A 还是 B""A 与 B 怎么选"这类二选一：`,
    `  A 和 B 是互斥选项，极少同时出现在同一帖里 —— 把 A B 组合成一个关键词命中率极低`,
    `  （实测"大厂 考公 选择"→0条）。因此：`,
    `  · 每个关键词都要是【选项 + 限定词】的 2 词组合，如：大厂 就业、考公 待遇、大厂 薪资、保研 复试；`,
    `  · 【禁止】输出裸单词（如"大厂""考公"）：实测这些词召回 20 条但绝大多数跑题，会挤掉精确结果。`,
    ``,
    `【C. 一般型】其余问题（最常见）：`,
    `  输出 4~5 个【2 词组合】，横向铺开覆盖面。两个维度都要换：`,
    `  · 换限定词：保研 英语、保研 英语要求、保研 复试；`,
    `  · 换核心词的同义说法（很重要）：cc98 用户可能不叫你那个词。`,
    `    例：学生工作 → 学生会/社团/部委/学生干部；就业 → 求职/秋招/offer；复习 → 备考/期末/资料。`,
    `  【禁止】输出裸单词（如"保研""考研"）：实测单词召回 20 条但绝大多数跑题，会污染结果。`,
    ``,
    `【A 类例外】只有稀有专有名词（人名/机构名）才允许单独成词，因为稀有词本身就很精确。`,
    ``,
    `通用要求：`,
    `1. 空格只用于「同一概念内的收窄」，不得用来连接两个并列概念；`,
    `2. 不要输出整句；去掉"怎么样/行不行/影响/怎么/为什么/请问/帮我看看"等虚词；`,
    `3. 每个关键词 2 个词为主（最多 3 个），靠换同义词铺开覆盖面，不要靠降级到宽泛单词；`,
    `4. 限定词要【论坛标题里常见】且能收窄范围，优先用：要求/条件/就业/薪资/备考/名额/经历/`,
    `   复习/资料/推荐/区别/待遇/经验。避免两类（实测都会拉低命中）：`,
    `   · 过于宽泛：时间/问题/相关/情况/介绍/分享；`,
    `   · 过于口语生僻：值不值/值不值得/行不行/体验/怎么看；`,
    `5. 严格只输出形如 ["词1 词2","词3 词4"] 的 JSON 数组。`
  ].join("\n");
  const text = await callDeepseekText([{ role: "system", content: system }, { role: "user", content: user }]);
  const m = String(text).match(/\[[\s\S]*\]/);
  let arr;
  try { arr = JSON.parse(m ? m[0] : text); } catch (e) { arr = [question]; }
  if (!Array.isArray(arr)) arr = [question];

  // 后处理：保留空格（同概念内收窄，如 "谭德志 实验室"）；
  // 对比型要额外过滤——实测这类问题的噪音几乎全来自裸单词和"A B 合并"式组合
  const isCompare = /还是|vs\.?|对比|哪个更好|怎么选|如何选择/i.test(question);
  const qHas = (p) => question.includes(p);
  const kws = [];
  const dropped = []; // 被过滤掉的，若最后为空则回退使用
  const seen = new Set();
  const push = (k) => {
    if (!k || k.length > 20) return; // 过长基本是整句，丢弃
    if (seen.has(k)) return;
    seen.add(k);
    kws.push(k);
  };
  for (const raw of arr) {
    let k = String(raw).replace(/\s+/g, " ").trim();
    if (!k) continue;
    let parts = k.split(" ");
    // 硬约束：最多 3 个词。实测 4 个词几乎必然 0 命中
    if (parts.length > 3) {
      parts = parts.slice(0, 3);
      k = parts.join(" ");
    }
    if (isCompare) {
      // 裸单词：召回高但绝大多数跑题（实测 top8 会被它们占满）
      if (parts.length === 1) { dropped.push(k); continue; }
      // "A B ..." 前两个词都是原问题里的互斥选项 → 命中率极低（实测 0 条）
      if (qHas(parts[0]) && qHas(parts[1])) { dropped.push(k); continue; }
    }
    push(k);
    if (kws.length >= 5) break;
  }
  // 兜底：若对比型过滤后一个不剩，退回未过滤的，别让搜索空转
  if (!kws.length) for (const d of dropped) push(d);
  // 精度优先：词多的在前、单词兜底在后。
  // 因为抓取只取候选列表前 topK 篇，若宽泛的单词排前面会把名额占满，挤掉精确结果。
  kws.sort((a, b) => b.split(" ").length - a.split(" ").length);
  return kws.length ? kws : [question];
}

// 官方接口关键词搜索
async function apiSearch(keyword) {
  const token = await ensureToken();
  await paceSearch(); // 搜索接口限流：每 5 秒最多一次，防止 429
  const url = `${API_BASE}/topic/search?keyword=${encodeURIComponent(keyword)}&from=0&size=20`;
  const data = await apiGet(url, token);
  const list = Array.isArray(data) ? data : [];
  return list.map((t) => ({
    id: t.id,
    title: t.title,
    boardName: t.boardName || "",
    author: t.isAnonymous ? "(匿名)" : (t.userName || ""),
    replyCount: t.replyCount || 0,
    time: t.time || ""
  }));
}

// 抓取楼层分页；若 size 过大被拒(400 invalid_from_or_size)，自动回退到更小 size
async function fetchPostsPage(topicId, from, size, token) {
  try {
    return await apiGet(`${API_BASE}/Topic/${topicId}/post?from=${from}&size=${size}`, token);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (/invalid_from_or_size/i.test(msg) && size > 10) {
      log(`size=${size} 被拒，回退 size=10（topic ${topicId}）`);
      return await apiGet(`${API_BASE}/Topic/${topicId}/post?from=${from}&size=10`, token);
    }
    throw e;
  }
}

// 只抓一个主题的首页楼层（浅层，用于快速给 AI 提供上下文）
async function crawlTopicShallow(id, fallbackTitle) {
  const token = await ensureToken();
  const title = fallbackTitle || ("帖子 #" + id);
  const size = Math.min(clamp(settings.rate.sizePerPage, 1, 30), 20);
  await sleep(300 + Math.random() * 500); // 浅层读取用更短的间隔
  const posts = await fetchPostsPage(id, 0, size, token);
  if (!Array.isArray(posts) || !posts.length) return `（「${title}」暂无可见内容）`;
  const chunks = [];
  for (const p of posts) {
    if (p.isDeleted) continue;
    const content = ubbToText(String(p.content || ""));
    if (!content) continue;
    const author = p.isAnonymous ? "(匿名)" : (p.userName || "匿名");
    chunks.push(`【${p.floor}楼 · ${author}】${content.slice(0, 300)}`);
  }
  return chunks.join("\n") || `（「${title}」暂无可见内容）`;
}

// 搜索问答的消息构造
function buildSearchMessages(question, material) {
  const system =
    "你是 CC98 论坛检索助手。根据给定材料直接回答用户问题。" +
    "硬性要求：精炼、信息密度高、完全基于材料，不得编造；" +
    "不要开场白、客套话、祝福语（如“祝xx顺利”）和免责声明（如“资源均为用户分享，如有错误请联系作者”）；" +
    "不要复述问题当标题；不要写结尾提醒或总结性套话；" +
    "涉及具体观点或资源时标注来源（如“3楼”），并且**必须给出原帖链接**，" +
    "格式为 [帖子标题](原帖链接)（链接就在材料里，直接照抄），方便用户点开查看原帖。输出 Markdown。";
  const materialText = Array.isArray(material) ? material.join("\n") : String(material);
  const user = `用户问题：${question}\n\n相关帖子内容：\n${materialText}\n\n请直接回答，并在提到某个帖子/资源时附上它的原帖链接。`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

// 非流式 DeepSeek 调用（用于关键词拆解等内部步骤）
async function callDeepseekText(messages) {
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
      temperature: 0,
      max_tokens: 300,
      stream: false
    })
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`DeepSeek 调用失败 ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
  return String(text || "");
}

async function crawlTopic(id, fallbackTitle) {
  const token = await ensureToken();
  const title = fallbackTitle || ("帖子 #" + id);

  const size = Math.min(clamp(settings.rate.sizePerPage, 1, 30), 20);
  const maxPages = settings.rate.maxPages;
  const chunks = [];

  for (let page = 0; page < maxPages; page++) {
    if (stopRequested) throw new Error("已停止");
    // 每个帖子内部翻页仍保持"人读帖"节奏
    await rateDelay();

    const from = page * size;
    const posts = await fetchPostsPage(id, from, size, token);
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
    log("apiGet：", r.status, url);

    if (r.ok) return await r.json();

    if (r.status === 401) {
      log("apiGet 401：令牌失效");
      throw new Error("登录令牌已失效，请刷新 cc98 页面后重试（插件会自动重新获取）");
    }

    // 限流 / 拒绝 / 服务器错误 → 指数退避重试
    if (r.status === 429 || r.status === 403 || r.status >= 500) {
      attempt++;
      log(`apiGet ${r.status}：退避重试 ${attempt}/${settings.rate.maxRetries}`);
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
    `5. 引用具体楼层时标注来源（如“3楼”），并**给出原帖链接**，格式 [帖子标题](原帖链接)（链接就在材料里，照抄即可），方便点开查看原帖；`,
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

// 搜索接口节拍：cc98 搜索限制每 5 秒最多一次，超了会 429
function paceSearch() {
  const now = Date.now();
  const gap = settings.rate.searchMinIntervalMs || 5000;
  const target = lastSearchAt + gap;
  lastSearchAt = Math.max(now, target);
  const wait = lastSearchAt - now;
  if (wait > 0) log(`搜索限流：等待 ${wait}ms 后再次搜索`);
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

// 发送带"步骤"信息的进度，供面板显示当前处于哪一步
function sendStage(tabId, stage, stageTotal, stageLabel, message, percent) {
  send(tabId, {
    type: "PROGRESS", phase: "search",
    stage, stageTotal, stageLabel, message, percent
  });
}

// 调试日志：仅在「调试模式」开启时打印到 Service Worker 控制台
function log(...args) {
  if (settings.debug) console.log("[CC98-AI]", ...args);
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
