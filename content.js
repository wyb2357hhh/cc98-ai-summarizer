// ============================================================================
// CC98 AI 总结 - 内容脚本
// 职责：悬浮面板（扫描本页勾选 → 主题输入）+ 独立大悬浮窗（Markdown 渲染输出）
// ============================================================================

(async () => {
  if (window.__cc98_ai_injected) return;
  window.__cc98_ai_injected = true;

  const state = {
    topics: [],            // 当前列表候选
    selected: new Map(),   // id -> topic
    running: false,
    sessionId: null,       // 当前会话 id（追问用）
    committed: "",         // 已完成答复的拼接文档（Markdown）
    raw: "",               // 正在流式生成的回复
    refs: "",              // 参考帖链接块（固定放在最末尾）
    outVisible: false,
    debug: false           // 调试模式
  };

  // -------------------------------------------------------------------------
  // 令牌：后台 webRequest 自动捕获为主，此处兜底扫描 + 状态回显
  // -------------------------------------------------------------------------
  function collectTokenCandidates() {
    const candidates = [];
    const add = (v) => {
      if (typeof v === "string" && v.trim() && v.trim().length > 20) candidates.push(v.trim());
    };
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === "object") {
          for (const f of ["access_token", "accessToken", "token", "id_token"]) {
            if (typeof obj[f] === "string") add(obj[f]);
          }
        }
      } catch (e) { /* 非 JSON */ }
      if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(raw)) add(raw);
      else if (/token|access|auth|jwt/i.test(key) && raw.length > 20) add(raw);
    }
    document.cookie.split(";").forEach((c) => {
      const eq = c.indexOf("=");
      if (eq < 0) return;
      const k = c.slice(0, eq).trim();
      const v = decodeURIComponent(c.slice(eq + 1).trim());
      if (/token|access|auth|jwt/i.test(k) && v.length > 10) add(v);
    });
    return candidates;
  }

  async function detectAndSend() {
    const candidates = collectTokenCandidates();
    if (candidates.length) {
      try {
        const r = await chrome.runtime.sendMessage({ type: "SET_TOKEN", candidates });
        if (r && r.ok) { setTokenStatus("已就绪：" + r.name); return; }
      } catch (e) { /* 继续 */ }
    }
    try {
      const s = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      if (s) {
        state.debug = !!s.settings && s.settings.debug;
        // 用设置里的默认抓取条数初始化面板输入框
        if (s.settings && s.settings.search && s.settings.search.topK) {
          $("cc98-ai-topk").value = s.settings.search.topK;
        }
        if (s.tokenSet) setTokenStatus("已就绪：" + (s.cc98Name || ""));
        else setTokenStatus("未获取令牌（浏览 cc98 页面自动获取，或到选项页手动填写）");
      } else {
        setTokenStatus("状态未知");
      }
    } catch (e) {
      setTokenStatus("状态未知");
    }
  }

  // -------------------------------------------------------------------------
  // 扫描本页帖子链接
  // -------------------------------------------------------------------------
  function extractTopicId(href) {
    if (!href) return null;
    let m;
    if ((m = href.match(/\/topic\/(\d+)/i))) return +m[1];
    if ((m = href.match(/[?&#](?:topicid|topic_id|topic)\s*=\s*(\d+)/i))) return +m[1];
    if ((m = href.match(/\/t\/(\d+)(?:\/|$)/i))) return +m[1];
    return null;
  }

  function scanPageTopics() {
    const seen = new Set();
    const out = [];
    document.querySelectorAll("a[href]").forEach((a) => {
      const id = extractTopicId(a.href);
      const title = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (id && title && !seen.has(id)) {
        seen.add(id);
        out.push({ id, title: title.slice(0, 80), boardName: "", author: "" });
      }
    });
    return out;
  }

  // -------------------------------------------------------------------------
  // 轻量 Markdown 渲染（先转义 HTML 再处理标记，防止注入）
  // -------------------------------------------------------------------------
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function mdInline(s) {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  }

  function mdToHtml(md) {
    const lines = String(md || "").split(/\r?\n/);
    const html = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 代码块
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(escapeHtml(lines[i])); i++; }
        i++; // 闭合 ``` 行
        html.push("<pre><code>" + buf.join("\n") + "</code></pre>");
        continue;
      }
      // 标题
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        html.push(`<h${m[1].length}>${mdInline(escapeHtml(m[2]))}</h${m[1].length}>`);
        i++;
        continue;
      }
      // 分隔线
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { html.push("<hr>"); i++; continue; }
      // 空行
      if (!line.trim()) { i++; continue; }
      // 引用
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(mdInline(escapeHtml(lines[i].replace(/^\s*>\s?/, ""))));
          i++;
        }
        html.push("<blockquote>" + buf.join("<br>") + "</blockquote>");
        continue;
      }
      // 列表
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length) {
          const mm = lines[i].match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
          if (!mm) break;
          items.push("<li>" + mdInline(escapeHtml(mm[1])) + "</li>");
          i++;
        }
        html.push(`<${ordered ? "ol" : "ul"}>` + items.join("") + `</${ordered ? "ol" : "ul"}>`);
        continue;
      }
      // 段落
      const buf = [];
      while (i < lines.length && lines[i].trim()) { buf.push(lines[i]); i++; }
      html.push("<p>" + mdInline(escapeHtml(buf.join(" "))) + "</p>");
    }
    return html.join("\n");
  }

  // -------------------------------------------------------------------------
  // UI 构建
  // -------------------------------------------------------------------------
  // 用 Shadow DOM 隔离宿主页面的样式。
  // 原因：Dark Reader 这类扩展会解析并改写页面元素的颜色，而它们不进入 shadow root，
  // 因此面板配色完全由我们自己的 CSS 决定，不会再出现"文字浅色 / 背景被刷白"的错乱。
  let cssText = "";
  try {
    cssText = await (await fetch(chrome.runtime.getURL("content.css"))).text();
  } catch (e) { /* 取不到就退化为普通 DOM，改用 manifest 注入的 CSS */ }

  let root, varStyleTarget;
  if (cssText) {
    const host = document.createElement("div");
    host.id = "cc98-ai-host";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${cssText}</style><div id="cc98-ai-root"></div>`;
    root = shadow.getElementById("cc98-ai-root");
    document.documentElement.appendChild(host);
    varStyleTarget = host; // 自定义属性会从 host 继承进 shadow
  } else {
    root = document.createElement("div");
    root.id = "cc98-ai-root";
    document.documentElement.appendChild(root);
    varStyleTarget = root;
  }
  root.innerHTML = `
    <!-- 看板娘（点击展开面板）。自带占位小人；若 assets/mascot.png 存在会自动替换 -->
    <div id="cc98-ai-mascot" title="CC98 AI 总结（点击展开面板）" data-state="idle">
      <svg class="cc98-ai-mascot-ph" viewBox="0 0 100 130" aria-hidden="true">
        <ellipse cx="17" cy="52" rx="9" ry="21" fill="#d9dceb"/>
        <ellipse cx="83" cy="52" rx="9" ry="21" fill="#d9dceb"/>
        <ellipse cx="50" cy="42" rx="28" ry="30" fill="#e8ebf6"/>
        <ellipse cx="50" cy="46" rx="21" ry="20" fill="#ffeadf"/>
        <path d="M29 38 Q50 15 71 38 Q60 29 50 31 Q40 29 29 38Z" fill="#e8ebf6"/>
        <ellipse cx="41" cy="48" rx="4" ry="5.5" fill="#3b3f57"/>
        <ellipse cx="59" cy="48" rx="4" ry="5.5" fill="#3b3f57"/>
        <circle cx="42.5" cy="45.8" r="1.4" fill="#fff"/>
        <circle cx="60.5" cy="45.8" r="1.4" fill="#fff"/>
        <ellipse cx="34" cy="54" rx="4" ry="2.4" fill="#ffc2cf" opacity=".85"/>
        <ellipse cx="66" cy="54" rx="4" ry="2.4" fill="#ffc2cf" opacity=".85"/>
        <path d="M47 55 q3 3 6 0" stroke="#c98b8b" stroke-width="1.4" fill="none" stroke-linecap="round"/>
        <path d="M50 66 q17 2 20 27 q0 8 -6 8 h-28 q-6 0 -6 -8 q3 -25 20 -27Z" fill="url(#cc98-mg)"/>
        <circle cx="50" cy="57" r="3.2" fill="#e05a78"/>
        <path d="M47 57 l-6 -3 v6Z" fill="#e05a78"/>
        <path d="M53 57 l6 -3 v6Z" fill="#e05a78"/>
        <defs>
          <linearGradient id="cc98-mg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#7b8cff"/>
            <stop offset="1" stop-color="#6a54e8"/>
          </linearGradient>
        </defs>
      </svg>
    </div>
    <div id="cc98-ai-bubble" hidden></div>

    <!-- 控制面板 -->
    <div id="cc98-ai-panel" hidden>
      <div class="cc98-ai-head">
        <span>CC98 AI 总结</span>
        <span class="cc98-ai-token" id="cc98-ai-token">—</span>
        <button id="cc98-ai-close" type="button" title="关闭">×</button>
      </div>
      <div class="cc98-ai-body">
        <!-- ① 问题搜索（主功能，常显） -->
        <div class="cc98-ai-sec">
          <div class="cc98-ai-sec-title">问题搜索</div>
          <div class="cc98-ai-row">
            <input type="text" id="cc98-ai-q" placeholder="输入问题，自动搜索并作答" />
            <input type="number" id="cc98-ai-topk" value="8" min="1" max="20" class="cc98-num" title="抓取前 N 篇帖子内容用于作答" />
          </div>
          <button id="cc98-ai-search" type="button" class="cc98-btn cc98-btn-primary cc98-btn-block">搜索并作答</button>
        </div>

        <!-- ② 勾选帖子（次要，可折叠；默认折叠） -->
        <div class="cc98-ai-sec">
          <button class="cc98-ai-sec-head" id="cc98-ai-sec-toggle" type="button" aria-expanded="false">
            <span class="cc98-ai-caret">▸</span>
            <span class="cc98-ai-sec-name">勾选帖子</span>
            <span class="cc98-ai-sec-badge" id="cc98-ai-count">已选 0</span>
          </button>
          <div class="cc98-ai-sec-body" id="cc98-ai-sec-body" hidden>
            <div class="cc98-ai-row">
              <button id="cc98-ai-scan-btn" type="button" class="cc98-btn cc98-btn-block">扫描本页</button>
              <button id="cc98-ai-load" type="button" class="cc98-btn" title="自动滚到底加载，直到目标条数">自动加载</button>
              <input type="number" id="cc98-ai-loadn" value="60" min="20" max="1000" class="cc98-num" title="自动加载的目标条数" />
            </div>
            <div id="cc98-ai-list" class="cc98-ai-list"></div>
            <div class="cc98-ai-tools">
              <span id="cc98-ai-list-title" class="cc98-ai-tools-label">本页帖子</span>
              <div class="cc98-ai-tools-right">
                <button id="cc98-ai-pick" type="button" class="cc98-btn-text" title="勾选前 N 篇">前</button>
                <input type="number" id="cc98-ai-pickn" value="5" min="1" max="999" class="cc98-num-inline" />
                <span class="cc98-ai-tools-label">篇</span>
                <label class="cc98-ai-selectall" title="勾选/取消全部">
                  <input type="checkbox" id="cc98-ai-selectall" /> 全选
                </label>
                <button id="cc98-ai-clear" type="button" class="cc98-btn-text" title="清空勾选">清空</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ③ 主题总结（主功能，常显） -->
        <div class="cc98-ai-sec">
          <div class="cc98-ai-sec-title">主题总结</div>
          <textarea id="cc98-ai-topic" rows="2" placeholder="总结主题，例如：这个专业就业怎么样"></textarea>
          <div class="cc98-ai-row">
            <button id="cc98-ai-start" type="button" class="cc98-btn cc98-btn-primary cc98-btn-block">开始总结</button>
            <button id="cc98-ai-stop" type="button" class="cc98-btn-text">停止</button>
          </div>
        </div>

        <div class="cc98-ai-progress">
          <div id="cc98-ai-stage" class="cc98-ai-stage"></div>
          <div class="bar"><div id="cc98-ai-progress-fill"></div></div>
          <div id="cc98-ai-progress-msg" class="msg"></div>
        </div>
      </div>
    </div>

    <!-- 输出大悬浮窗 -->
    <div id="cc98-ai-out" hidden>
      <div class="cc98-ai-out-head">
        <span class="cc98-ai-out-title" id="cc98-ai-out-title">总结结果</span>
        <span class="cc98-ai-out-status" id="cc98-ai-out-status"></span>
        <button id="cc98-ai-out-copy" type="button">复制 Markdown</button>
        <button id="cc98-ai-out-close" type="button" title="关闭">×</button>
      </div>
      <div class="cc98-ai-out-progress" id="cc98-ai-out-progress">
        <div class="cc98-ai-out-stage" id="cc98-ai-out-progress-msg"></div>
        <div class="bar"><div id="cc98-ai-out-progress-fill"></div></div>
      </div>
      <div id="cc98-ai-out-body" class="cc98-ai-out-body">
        <div class="cc98-ai-md"></div>
      </div>
      <div id="cc98-ai-out-foot" class="cc98-ai-out-foot">
        <textarea id="cc98-ai-question" rows="2" placeholder="就结果追问 AI…（例如：3楼说的理由是什么）"></textarea>
        <button id="cc98-ai-ask" type="button" class="primary">追问</button>
      </div>
    </div>
  `;
  // 注意：root 已在上面的分支里挂载（shadow 内或 documentElement 下），此处不再 append

  const $ = (id) => root.querySelector("#" + id);
  const panel = $("cc98-ai-panel");
  const listEl = $("cc98-ai-list");
  const outEl = $("cc98-ai-out");
  const outBody = $("cc98-ai-out-body");

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------
  $("cc98-ai-mascot").addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { detectAndSend(); autoScan(); }
    mascotSay("", 0);
  });

  // ---- 看板娘：真图探测 + 状态机 ----
  const MASCOT_STATES = {
    idle:  ["", "在的哦～", "点我打开面板"],
    work:  ["在翻了在翻了…", "等我一下下", "正在读帖子…"],
    done:  ["找到啦！", "整理好了～", "看结果吧"],
    error: ["唔…出错了", "这个没搜到呢", "再试一次？"]
  };
  const mascotEl = $("cc98-ai-mascot");
  const bubbleEl = $("cc98-ai-bubble");
  let mascotTimer = null;

  function mascotSay(text, ms) {
    if (!text || !ms) { bubbleEl.hidden = true; clearTimeout(mascotTimer); return; }
    bubbleEl.textContent = text;
    bubbleEl.hidden = false;
    clearTimeout(mascotTimer);
    mascotTimer = setTimeout(() => (bubbleEl.hidden = true), ms);
  }

  function setMascotState(st, sayMs) {
    mascotEl.dataset.state = st;
    const pool = MASCOT_STATES[st] || MASCOT_STATES.idle;
    const text = pool[Math.floor(Math.random() * pool.length)];
    mascotSay(text, sayMs || 2600);
    // 完成/出错是瞬时状态，过一会儿回到待机
    if (st === "done" || st === "error") {
      setTimeout(() => { if (mascotEl.dataset.state === st) mascotEl.dataset.state = "idle"; }, 2600);
    }
  }

  // 若扩展内存在 assets/mascot.png，自动替换掉内置占位小人
  (function probeMascotImage() {
    try {
      const url = chrome.runtime.getURL("assets/mascot.png");
      const img = new Image();
      img.onload = () => {
        varStyleTarget.style.setProperty("--cc98-mascot-img", `url("${url}")`);
        mascotEl.classList.add("has-img");
      };
      img.onerror = () => { /* 没有真图就用内置占位小人 */ };
      img.src = url;
    } catch (e) { /* 忽略 */ }
  })();
  $("cc98-ai-close").addEventListener("click", () => (panel.hidden = true));

  // 折叠/展开「勾选帖子」区块
  function setPickExpanded(open) {
    $("cc98-ai-sec-body").hidden = !open;
    $("cc98-ai-sec-toggle").setAttribute("aria-expanded", open ? "true" : "false");
    $("cc98-ai-sec-toggle").classList.toggle("open", open);
  }
  $("cc98-ai-sec-toggle").addEventListener("click", () => {
    setPickExpanded($("cc98-ai-sec-body").hidden);
  });

  $("cc98-ai-scan-btn").addEventListener("click", autoScan);
  $("cc98-ai-load").addEventListener("click", autoLoadMore);
  $("cc98-ai-selectall").addEventListener("change", (e) => {
    if (e.target.checked) {
      state.topics.forEach((t) => state.selected.set(t.id, t));
    } else {
      state.selected.clear();
    }
    refreshChecks();
  });
  $("cc98-ai-clear").addEventListener("click", () => {
    state.selected.clear();
    refreshChecks();
    setStatus("");
    setProgress(0, "");
  });
  $("cc98-ai-stop").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "STOP" }).catch(() => {});
    setStatus("正在停止…");
  });
  $("cc98-ai-start").addEventListener("click", startSummarize);
  $("cc98-ai-search").addEventListener("click", doQuestionSearch);
  $("cc98-ai-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doQuestionSearch(); }
  });

  // 快速选中前 N 条
  $("cc98-ai-pick").addEventListener("click", () => {
    const n = Math.max(1, parseInt($("cc98-ai-pickn").value, 10) || 5);
    state.topics.slice(0, n).forEach((t) => state.selected.set(t.id, t));
    refreshChecks();
    setStatus(`已选前 ${Math.min(n, state.topics.length)} 篇`);
  });

  // 追问并清空评论框后发送
  function askCurrent() {
    const q = $("cc98-ai-question").value.trim();
    if (!q) return outStatus("请先输入问题");
    followUp(q);
    $("cc98-ai-question").value = "";
  }
  $("cc98-ai-ask").addEventListener("click", askCurrent);
  $("cc98-ai-question").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askCurrent(); }
  });

  $("cc98-ai-out-close").addEventListener("click", () => { outEl.hidden = true; state.outVisible = false; });
  $("cc98-ai-out-copy").addEventListener("click", async () => {
    try {
      const doc = state.committed + (state.raw ? "\n\n" + state.raw : "") + state.refs;
      await navigator.clipboard.writeText(doc || "");
      outStatus("已复制");
      setTimeout(() => outStatus(state.running ? "生成中…" : "完成，可继续追问"), 1500);
    } catch (e) {
      outStatus("复制失败，请手动选中");
    }
  });

  // 后台推送：进度 / 流式增量 / 结果 / 错误
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "PROGRESS") onProgress(msg);
    else if (msg.type === "STREAM_DELTA") onStreamDelta(msg.delta || "");
    else if (msg.type === "RESULT") onResult(msg);
    else if (msg.type === "SEARCH_RESULT") onSearchResult(msg);
    else if (msg.type === "FOLLOWUP_DONE") onFollowupDone();
    else if (msg.type === "ERROR") onError(msg.message);
  });

  function autoScan() {
    const found = scanPageTopics();
    renderList(found);
    if (found.length) setStatus(`扫描到 ${found.length} 篇，勾选后输入主题开始总结`);
    else setStatus("本页未识别到帖子链接，请到搜索页/版面页打开面板");
  }

  // 自动滚到底触发"上拉加载"，直到加载到目标条数或到底为止
  async function autoLoadMore() {
    const target = Math.max(20, parseInt($("cc98-ai-loadn").value, 10) || 60);
    const btn = $("cc98-ai-load");
    btn.disabled = true;
    setStatus(`自动加载中，目标 ${target} 条…`);

    let lastCount = -1;
    let noGrowth = 0;
    let guard = 0;
    const MAX_SCROLLS = 80;

    while (guard++ < MAX_SCROLLS) {
      const count = scanPageTopics().length;
      if (count >= target) {
        setStatus(`已加载到 ${count} 条，达到目标`);
        break;
      }

      // 滚到底触发加载
      window.scrollTo(0, document.documentElement.scrollHeight);
      // 限速等待：给页面加载时间 + 随机间隔，模拟真人
      await sleep(1200 + Math.random() * 1200);

      const after = scanPageTopics().length;
      if (after > lastCount) {
        noGrowth = 0;
      } else {
        noGrowth++;
      }
      lastCount = after;
      setStatus(`已加载 ${after} 条…`);

      if (noGrowth >= 4) {
        setStatus(`已到底（当前 ${after} 条，未达 ${target}）`);
        break;
      }
    }

    btn.disabled = false;
    autoScan();
  }

  function renderList(topics, label) {
    state.topics = topics || [];
    $("cc98-ai-list-title").textContent = label || "本页帖子";
    listEl.innerHTML = "";
    if (!state.topics.length) {
      listEl.innerHTML = '<div class="cc98-ai-empty">' + (label === "参考帖" ? "没有搜到相关帖子" : "本页没有识别到帖子链接") + '</div>';
      refreshCount();
      return;
    }
    state.topics.forEach((t) => {
      const item = document.createElement("label");
      item.className = "cc98-ai-item";
      const checked = state.selected.has(t.id);
      item.innerHTML = `
        <input type="checkbox" data-id="${t.id}" ${checked ? "checked" : ""} />
        <span class="cc98-ai-item-main">
          <span class="cc98-ai-item-title">${escapeHtml(t.title)}</span>
          <span class="cc98-ai-item-meta">#${t.id}${t.author ? " · " + escapeHtml(t.author) : ""}${t.replyCount ? " · " + t.replyCount + " 回复" : ""}</span>
        </span>
      `;
      listEl.appendChild(item);
    });
    refreshCount();
  }

  listEl.addEventListener("change", (e) => {
    const cb = e.target;
    if (cb && cb.type === "checkbox" && cb.dataset.id) {
      const id = +cb.dataset.id;
      const t = state.topics.find((x) => x.id === id);
      if (cb.checked && t) state.selected.set(id, t);
      else state.selected.delete(id);
      refreshCount();
    }
  });

  function refreshChecks() {
    listEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = state.selected.has(+cb.dataset.id);
    });
    // 同步“全选”状态
    const all = state.topics.length > 0 && state.topics.every((t) => state.selected.has(t.id));
    const any = state.topics.some((t) => state.selected.has(t.id));
    const sa = $("cc98-ai-selectall");
    sa.checked = all;
    sa.indeterminate = !all && any;
    refreshCount();
  }

  function refreshCount() {
    $("cc98-ai-count").textContent = "已选 " + state.selected.size;
  }

  // 问题式搜索：用户给问题 → 后台拆关键词搜索 + AI 生成答案 + 参考帖回填
  async function doQuestionSearch() {
    const q = $("cc98-ai-q").value.trim();
    if (!q) return setStatus("请先输入问题");
    if (state.running) return;
    log("发起问题搜索：", q);

    state.running = true;
    state.sessionId = null;
    state.committed = "";
    state.raw = "";
    state.refs = "";
    state.selected.clear();
    refreshChecks();

    $("cc98-ai-search").disabled = true;
    $("cc98-ai-start").disabled = true;
    $("cc98-ai-ask").disabled = true;

    setProgress(3, "正在拆解关键词…");
    setStatus("");
    showOut();
    $("cc98-ai-out-progress-fill").style.width = "0%";
    $("cc98-ai-out-progress-msg").textContent = "准备中…";
    $("cc98-ai-out-title").textContent = q;
    setMascotState("work", 2600);
    outStatus("搜索中…");
    outBody.innerHTML = '<div class="cc98-ai-md"><p class="cc98-ai-md-empty">正在搜索并分析…</p></div>';

    const topK = Math.max(1, Math.min(20, parseInt($("cc98-ai-topk").value, 10) || 8));
    try {
      const r = await chrome.runtime.sendMessage({ type: "QUESTION_SEARCH", question: q, topK });
      if (r && r.error) { onError(r.error); return; }
    } catch (e) {
      onError(e.message || String(e));
    }
  }

  async function startSummarize() {
    const topic = $("cc98-ai-topic").value.trim();
    if (!topic) return setStatus("请先输入总结主题");
    if (!state.selected.size) return setStatus("请先勾选要总结的帖子");
    if (state.running) return;

    const items = Array.from(state.selected.values()).map((t) => ({ id: t.id, title: t.title }));
    state.running = true;
    state.sessionId = null;
    state.committed = "";
    state.raw = "";
    state.refs = "";
    $("cc98-ai-start").disabled = true;
    $("cc98-ai-search").disabled = true;
    setProgress(1, "准备开始…");
    setStatus("");

    $("cc98-ai-ask").disabled = true;
    // 打开输出窗占位
    showOut();
    $("cc98-ai-out-progress-fill").style.width = "0%";
    $("cc98-ai-out-progress-msg").textContent = "准备中…";
    $("cc98-ai-out-title").textContent = topic;
    setMascotState("work", 2600);
    outStatus("抓取帖子中…");
    outBody.innerHTML = '<div class="cc98-ai-md"><p class="cc98-ai-md-empty">正在限速抓取选中帖子…</p></div>';

    try {
      const r = await chrome.runtime.sendMessage({ type: "START_SUMMARIZE", topic, items });
      if (r && r.error) { onError(r.error); return; }
    } catch (e) {
      onError(e.message || String(e));
    }
  }

  // 进度同时显示在控制面板和输出窗（用户要求进度放在回答框里）
  function onProgress(msg) {
    if (msg.stageLabel) {
      $("cc98-ai-stage").textContent = `步骤 ${msg.stage}/${msg.stageTotal} · ${msg.stageLabel}`;
      $("cc98-ai-out-progress-msg").textContent = `步骤 ${msg.stage}/${msg.stageTotal} · ${msg.stageLabel} — ${msg.message || ""}`;
    } else if (msg.message) {
      $("cc98-ai-out-progress-msg").textContent = msg.message;
    }
    const pct = Math.max(0, Math.min(100, msg.percent || 0));
    $("cc98-ai-out-progress-fill").style.width = pct + "%";
    setProgress(msg.percent || 0, msg.message || "");
    if (msg.phase === "crawl" && state.running) outStatus("抓取中…");
    if (mascotEl.dataset.state !== "work") setMascotState("work", 2600);
  }

  // 每一轮 AI 回复采用“最终文档 committed + 正在流式渲染的 raw”拼接展示，
  // 追问的内容作为一段“你的追问”合并进文档，实现可回溯的多轮对话。
  function onStreamDelta(delta) {
    state.raw += delta;
    showOut();
    outStatus("生成中…");
    renderOut();
  }

  // 生成"参考帖"链接列表，保证每条都能点开原帖
  function refBlock(topics) {
    const list = (topics || []).filter((t) => t && t.id);
    if (!list.length) return "";
    const items = list
      .map((t) => {
        const title = String(t.title || ("帖子 #" + t.id)).replace(/[[\]]/g, "");
        return `- [${title}](https://www.cc98.org/topic/${t.id})`;
      })
      .join("\n");
    return "\n\n---\n\n**参考帖（点击查看原帖）**\n" + items;
  }

  // 首轮总结结束：以 RESULT.summary 作为完整首轮答案固化
  function onResult(msg) {
    log("收到 RESULT");
    state.running = false;
    $("cc98-ai-start").disabled = false;
    $("cc98-ai-search").disabled = false;
    state.sessionId = msg.sessionId || null;
    state.committed = msg.summary || (state.raw || "");
    state.refs = refBlock(msg.refTopics);
    state.raw = "";
    showOut();
    outStatus("完成，可继续追问");
    renderOut();
    setProgress(100, "完成");
    setStage("");
    outProgressDone();
    enableAsk();
    setMascotState("done");
  }

  // 问题式搜索完成：答案固化 + 参考帖回填列表 + 允许追问
  function onSearchResult(msg) {
    log("收到 SEARCH_RESULT：参考帖", (msg.topics || []).length);
    state.running = false;
    $("cc98-ai-start").disabled = false;
    $("cc98-ai-search").disabled = false;
    state.sessionId = msg.sessionId || null; // 搜索也建了会话，可以继续追问
    state.committed = msg.answer || (state.raw || "");
    state.refs = refBlock(msg.refTopics || msg.topics);
    state.raw = "";
    state.topics = Array.isArray(msg.topics) ? msg.topics : [];
    renderList(state.topics, "参考帖");
    if (state.topics.length) setPickExpanded(true); // 有参考帖就自动展开该区块
    showOut();
    outStatus("完成，可继续追问");
    renderOut();
    setProgress(100, "完成");
    setStage("完成");
    outProgressDone();
    setStatus(`搜索完成：${state.topics.length} 篇参考帖已列出，可勾选后「开始总结」`);
    enableAsk();
    setMascotState("done");
  }

  // 输出窗进度收尾
  function outProgressDone() {
    $("cc98-ai-out-progress-fill").style.width = "100%";
    $("cc98-ai-out-progress-msg").textContent = "完成";
  }

  // 追问完成后，把流式内容固化进文档
  function onFollowupDone() {
    if (state.raw) state.committed = state.committed + "\n\n" + state.raw;
    state.raw = "";
    state.running = false;
    $("cc98-ai-start").disabled = false;
    $("cc98-ai-search").disabled = false;
    enableAsk();
    outStatus("完成，可继续追问");
    outProgressDone();
    renderOut();
    setMascotState("done");
  }

  // 追问开始于提交时：写入“你的追问”段落并清空 raw
  function beginAskRendering(q) {
    state.committed = (state.committed ? state.committed + "\n\n" : "") +
      ("> **你的追问：** " + q);
  }

  function onError(message) {
    log("收到 ERROR：", message);
    state.running = false;
    $("cc98-ai-start").disabled = false;
    $("cc98-ai-search").disabled = false;
    showOut();
    outStatus("已中断");
    renderOut();
    setProgress(0, "");
    setStage("");
    $("cc98-ai-out-progress-msg").textContent = "已中断";
    setStatus("错误：" + message);
    setMascotState("error");
  }

  function enableAsk() {
    const ask = $("cc98-ai-ask");
    if (!ask) return;
    ask.disabled = !state.sessionId || state.running;
  }

  // 发起追问：写入“你的追问”段，把会话 id + 问题发给后台流式回答
  async function followUp(question) {
    if (state.running || !state.sessionId) return;
    state.running = true;
    $("cc98-ai-start").disabled = true;
    $("cc98-ai-ask").disabled = true;
    // 追加追问行到最终文档，随后流式答案再补上
    beginAskRendering(question);
    state.raw = "";
    showOut();
    outStatus("生成中…");
    $("cc98-ai-out-progress-msg").textContent = "正在回答追问…";
    $("cc98-ai-out-progress-fill").style.width = "50%";
    setMascotState("work", 2600);
    renderOut();
    setStatus("");
    try {
      const r = await chrome.runtime.sendMessage({
        type: "FOLLOWUP",
        sessionId: state.sessionId,
        question
      });
      if (r && r.error) { onError(r.error); return; }
    } catch (e) {
      onError(e.message || String(e));
    }
  }

  function showOut() {
    if (state.outVisible) return;
    state.outVisible = true;
    outEl.hidden = false;
  }

  function outStatus(text) {
    $("cc98-ai-out-status").textContent = text;
  }

  // 渲染：最终文案 + （若有）流式中的回复 + 末尾固定的参考帖块
  function renderOut() {
    const nearBottom = outBody.scrollHeight - outBody.scrollTop - outBody.clientHeight < 80;
    const doc = state.committed + (state.raw ? "\n\n" + state.raw : "") + state.refs;
    const html = doc ? mdToHtml(doc) : '<div class="cc98-ai-md"><p class="cc98-ai-md-empty">等待回复…</p></div>';
    outBody.innerHTML = '<div class="cc98-ai-md">' + html + "</div>";
    if (nearBottom) outBody.scrollTop = outBody.scrollHeight;
  }

  function setProgress(percent, message) {
    $("cc98-ai-progress-fill").style.width = Math.max(0, Math.min(100, percent)) + "%";
    $("cc98-ai-progress-msg").textContent = message || "";
  }

  function setStatus(text) {
    $("cc98-ai-progress-msg").textContent = text;
  }

  function setTokenStatus(text) {
    $("cc98-ai-token").textContent = text;
  }

  function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }

  function log(...args) {
    if (state.debug) console.log("[CC98-AI]", ...args);
  }

  function setStage(text) {
    const el = $("cc98-ai-stage");
    if (el) el.textContent = text || "";
  }

  // -------------------------------------------------------------------------
  // 窗口拖动（按住标题栏移动）
  // -------------------------------------------------------------------------
  function makeDraggable(el, handleSel) {
    const handle = el.querySelector(handleSel);
    if (!handle) return;
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.style.left = ox + "px";
      el.style.top = oy + "px";
      handle.style.cursor = "grabbing";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const nx = Math.min(Math.max(-8, ox + (e.clientX - sx)), window.innerWidth - 80);
      const ny = Math.min(Math.max(-8, oy + (e.clientY - sy)), window.innerHeight - 48);
      el.style.left = nx + "px";
      el.style.top = ny + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      handle.style.cursor = "";
    });
  }

  makeDraggable(panel, ".cc98-ai-head");
  makeDraggable(outEl, ".cc98-ai-out-head");

  // 页面加载即检测令牌（后台 webRequest 持续自动捕获）
  detectAndSend();
})();
