// 选项页：读取/保存设置，并显示令牌状态
const $ = (id) => document.getElementById(id);

async function load() {
  const r = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!r || !r.settings) return;

  const s = r.settings;
  $("baseUrl").value = s.deepseek.baseUrl;
  $("apiKey").value = s.deepseek.apiKey;
  $("model").value = s.deepseek.model;
  $("temperature").value = s.deepseek.temperature;
  $("maxTokens").value = s.deepseek.maxTokens;

  $("searchTopK").value = s.search.topK;
  $("searchMaxCandidates").value = s.search.maxCandidates;
  $("debug").checked = !!s.debug;

  // 令牌手动输入框留空（不回显），只显示状态
  $("tokenStatus").textContent = s.cc98Name
    ? `当前已就绪：${s.cc98Name}`
    : "当前状态：未获取到令牌（请登录 cc98 并打开任意页面）";
}

$("save").addEventListener("click", async () => {
  const num = (v, d) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; };
  const patch = {
    deepseek: {
      baseUrl: $("baseUrl").value.trim() || "https://api.deepseek.com",
      apiKey: $("apiKey").value.trim(),
      model: $("model").value.trim() || "deepseek-chat",
      temperature: parseFloat($("temperature").value),
      maxTokens: num($("maxTokens").value, 2000)
    },
    search: {
      topK: num($("searchTopK").value, 8),
      maxCandidates: num($("searchMaxCandidates").value, 40)
    },
    debug: $("debug").checked
  };
  if (Number.isNaN(patch.deepseek.temperature)) patch.deepseek.temperature = 0.3;
  // 手动令牌：仅当填写时才覆盖
  const token = $("cc98Token").value.trim();
  if (token) patch.cc98Token = token;

  const res = await chrome.runtime.sendMessage({ type: "SETTINGS", patch });
  if (token) {
    $("status").textContent = res && res.tokenSet
      ? "令牌验证通过 已就绪：" + (res.cc98Name || "")
      : "令牌验证失败 请确认复制完整（Bearer 后面整串）";
  } else {
    $("status").textContent = "已保存";
  }
  setTimeout(() => ($("status").textContent = ""), 3000);
  load();
});

load();
