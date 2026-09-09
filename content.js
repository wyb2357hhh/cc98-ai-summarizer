// ============================================================================
// CC98 AI 总结 - 内容脚本
// 职责：悬浮面板（扫描本页勾选 → 主题输入）+ 独立大悬浮窗（Markdown 渲染输出）
// ============================================================================

(() => {
  if (window.__cc98_ai_injected) return;
  window.__cc98_ai_injected = true;

  const state = {
    topics: [],            // 当前列表候选
    selected: new Map(),   // id -> topic
    running: false,
    streamed: "",          // 已流式收到的原始 Markdown
    outVisible: false
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
      if (s && s.tokenSet) setTokenStatus("已就绪：" + (s.cc98Name || ""));
      else setTokenStatus("未获取令牌（浏览 cc98 页面自动获取，或到选项页手动填写）");
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
  const root = document.createElement("div");
  root.id = "cc98-ai-root";
  root.innerHTML = `
    <button id="cc98-ai-fab" type="button" title="CC98 AI 总结"></button>

    <!-- 控制面板 -->
    <div id="cc98-ai-panel" hidden>
      <div class="cc98-ai-head">
        <span>CC98 AI 总结</span>
        <span class="cc98-ai-token" id="cc98-ai-token">—</span>
        <button id="cc98-ai-close" type="button" title="关闭">×</button>
      </div>
      <div class="cc98-ai-body">
        <div class="cc98-ai-row">
          <button id="cc98-ai-scan-btn" type="button" class="cc98-ai-scan-btn">🔄 扫描本页帖子</button>
          <button id="cc98-ai-clear" type="button" title="清空勾选">清空</button>
        </div>
        <p class="cc98-ai-hint">在论坛搜索页 / 版面页打开，勾选要总结的帖子</p>

        <div class="cc98-ai-list-head">
          <span id="cc98-ai-list-title">本页帖子</span>
          <span class="cc98-ai-list-tools">
            <label class="cc98-ai-selectall" title="勾选/取消本页全部帖子">
              <input type="checkbox" id="cc98-ai-selectall" /> 全选
            </label>
            <span id="cc98-ai-count">已选 0</span>
          </span>
        </div>
        <div id="cc98-ai-list" class="cc98-ai-list"></div>

        <textarea id="cc98-ai-topic" rows="2" placeholder="总结主题，例如：这个专业就业怎么样"></textarea>

        <div class="cc98-ai-row">
          <button id="cc98-ai-start" type="button" class="primary">开始总结</button>
          <button id="cc98-ai-stop" type="button">停止</button>
        </div>

        <div class="cc98-ai-progress">
          <div class="bar"><div id="cc98-ai-progress-fill"></div></div>
          <div id="cc98-ai-progress-msg" class="msg"></div>
        </div>
      </div>
    </div>

    <!-- 输出大悬浮窗 -->
    <div id="cc98-ai-out" hidden>
      <div class="cc98-ai-out-head">
        <span class="cc98-ai-out-title" id="cc98-ai-out-title">📄 总结结果</span>
        <span class="cc98-ai-out-status" id="cc98-ai-out-status"></span>
        <button id="cc98-ai-out-copy" type="button">复制 Markdown</button>
        <button id="cc98-ai-out-close" type="button" title="关闭">×</button>
      </div>
      <div id="cc98-ai-out-body" class="cc98-ai-out-body">
        <div class="cc98-ai-md"></div>
      </div>
    </div>
  `;
  document.documentElement.appendChild(root);

  const $ = (id) => root.querySelector("#" + id);
  const panel = $("cc98-ai-panel");
  const listEl = $("cc98-ai-list");
  const outEl = $("cc98-ai-out");
  const outBody = $("cc98-ai-out-body");

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------
  $("cc98-ai-fab").addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { detectAndSend(); autoScan(); }
  });
  $("cc98-ai-close").addEventListener("click", () => (panel.hidden = true));
  $("cc98-ai-scan-btn").addEventListener("click", autoScan);
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

  $("cc98-ai-out-close").addEventListener("click", () => { outEl.hidden = true; state.outVisible = false; });
  $("cc98-ai-out-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.streamed || "");
      outStatus("已复制 ✓");
      setTimeout(() => outStatus(state.running ? "生成中…" : "完成"), 1500);
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
    else if (msg.type === "ERROR") onError(msg.message);
  });

  function autoScan() {
    const found = scanPageTopics();
    renderList(found);
    if (found.length) setStatus(`扫描到 ${found.length} 篇，勾选后输入主题开始总结`);
    else setStatus("本页未识别到帖子链接，请到搜索页/版面页打开面板");
  }

  function renderList(topics) {
    state.topics = topics || [];
    listEl.innerHTML = "";
    if (!state.topics.length) {
      listEl.innerHTML = '<div class="cc98-ai-empty">本页没有识别到帖子链接</div>';
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

  async function startSummarize() {
    const topic = $("cc98-ai-topic").value.trim();
    if (!topic) return setStatus("请先输入总结主题");
    if (!state.selected.size) return setStatus("请先勾选要总结的帖子");
    if (state.running) return;

    const items = Array.from(state.selected.values()).map((t) => ({ id: t.id, title: t.title }));
    state.running = true;
    state.streamed = "";
    $("cc98-ai-start").disabled = true;
    setProgress(1, "准备开始…");
    setStatus("");

    // 打开输出窗占位
    showOut();
    $("cc98-ai-out-title").textContent = "📄 " + topic;
    outStatus("抓取帖子中…");
    outBody.innerHTML = '<div class="cc98-ai-md"><p class="cc98-ai-md-empty">正在限速抓取选中帖子…</p></div>';

    try {
      const r = await chrome.runtime.sendMessage({ type: "START_SUMMARIZE", topic, items });
      if (r && r.error) { onError(r.error); return; }
    } catch (e) {
      onError(e.message || String(e));
    }
  }

  function onProgress(msg) {
    setProgress(msg.percent || 0, msg.message || "");
    if (msg.phase === "crawl" && state.running) outStatus("抓取中…");
  }

  function onStreamDelta(delta) {
    state.streamed += delta;
    showOut();
    outStatus("生成中…");
    renderOut();
  }

  function onResult(msg) {
    state.running = false;
    $("cc98-ai-start").disabled = false;
    if (msg.summary && !state.streamed) state.streamed = msg.summary; // 兜底
    showOut();
    outStatus("完成");
    renderOut();
    setProgress(100, "完成");
  }

  function onError(message) {
    state.running = false;
    $("cc98-ai-start").disabled = false;
    outStatus("已中断");
    renderOut();
    setProgress(0, "");
    setStatus("错误：" + message);
  }

  function showOut() {
    if (state.outVisible) return;
    state.outVisible = true;
    outEl.hidden = false;
  }

  function outStatus(text) {
    $("cc98-ai-out-status").textContent = text;
  }

  function renderOut() {
    const nearBottom = outBody.scrollHeight - outBody.scrollTop - outBody.clientHeight < 80;
    const html = state.streamed ? mdToHtml(state.streamed) : "";
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
