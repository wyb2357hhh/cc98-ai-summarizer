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

  $("baseDelayMs").value = s.rate.baseDelayMs;
  $("jitterMs").value = s.rate.jitterMs;
  $("sizePerPage").value = s.rate.sizePerPage;
  $("maxPages").value = s.rate.maxPages;
  $("maxTotalChars").value = s.rate.maxTotalChars;
  $("maxRetries").value = s.rate.maxRetries;

  // 令牌手动输入框留空（不回显），只显示状态
  $("tokenStatus").textContent = s.cc98Name
    ? `当前已就绪：${s.cc98Name}`
    : "当前状态：未获取到令牌（请登录 cc98 并打开任意页面）";
}

$("save").addEventListener("click", async () => {
  const patch = {
    deepseek: {
      baseUrl: $("baseUrl").value.trim() || "https://api.deepseek.com",
      apiKey: $("apiKey").value.trim(),
      model: $("model").value.trim() || "deepseek-chat",
      temperature: parseFloat($("temperature").value) || 0.3,
      maxTokens: parseInt($("maxTokens").value, 10) || 2000
    },
    rate: {
      baseDelayMs: parseInt($("baseDelayMs").value, 10) || 3000,
      jitterMs: parseInt($("jitterMs").value, 10) || 3000,
      sizePerPage: parseInt($("sizePerPage").value, 10) || 20,
      maxPages: parseInt($("maxPages").value, 10) || 5,
      maxTotalChars: parseInt($("maxTotalChars").value, 10) || 60000,
      maxRetries: parseInt($("maxRetries").value, 10) || 3
    }
  };
  // 手动令牌：仅当填写时才覆盖
  const token = $("cc98Token").value.trim();
  if (token) patch.cc98Token = token;

  const res = await chrome.runtime.sendMessage({ type: "SETTINGS", patch });
  if (token) {
    $("status").textContent = res && res.tokenSet
      ? "令牌验证通过 ✔ 已就绪：" + (res.cc98Name || "")
      : "令牌验证失败 ✘ 请确认复制完整（Bearer 后面整串）";
  } else {
    $("status").textContent = "已保存 ✔";
  }
  setTimeout(() => ($("status").textContent = ""), 3000);
  load();
});

load();
