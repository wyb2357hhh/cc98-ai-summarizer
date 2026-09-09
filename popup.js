async function refresh() {
  const r = await chrome.runtime.sendMessage({ type: "GET_STATE" }).catch(() => null);
  if (!r) return;
  document.getElementById("token").innerHTML = r.tokenSet
    ? `令牌：<span class="ok">已就绪${r.cc98Name ? "（" + r.cc98Name + "）" : ""}</span>`
    : `令牌：<span class="bad">未获取（请登录 cc98 并打开任意页面）</span>`;
  document.getElementById("ai").innerHTML = r.deepseekConfigured
    ? 'DeepSeek：<span class="ok">已配置</span>'
    : 'DeepSeek：<span class="bad">未配置 API Key</span>';
}

document.getElementById("open").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.cc98.org/" });
});
document.getElementById("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refresh();
