async function refresh() {
  const r = await chrome.runtime.sendMessage({ type: "GET_STATE" }).catch(() => null);
  if (!r) return;

  const tokDot = document.getElementById("tokDot");
  const tokText = document.getElementById("tokText");
  const aiDot = document.getElementById("aiDot");
  const aiText = document.getElementById("aiText");

  if (r.tokenSet) {
    tokDot.className = "dot ok";
    tokText.innerHTML = `<span class="ok">已就绪${r.cc98Name ? "（" + r.cc98Name + "）" : ""}</span>`;
  } else {
    tokDot.className = "dot bad";
    tokText.innerHTML = '<span class="bad">未获取（登录 cc98 后自动捕获）</span>';
  }

  if (r.deepseekConfigured) {
    aiDot.className = "dot ok";
    aiText.innerHTML = '<span class="ok">已配置</span>';
  } else {
    aiDot.className = "dot bad";
    aiText.innerHTML = '<span class="bad">未配置 API Key</span>';
  }
}

document.getElementById("open").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.cc98.org/" });
});
document.getElementById("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refresh();
