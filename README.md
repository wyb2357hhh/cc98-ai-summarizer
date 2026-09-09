# CC98 AI 主题总结（Chrome MV3 扩展）

勾选 cc98 论坛搜索结果 → 自动限速爬取选中帖子正文 → 用 **DeepSeek** 按你输入的主题生成总结。

## 功能

- 悬浮面板，在任意 cc98 页面右下角点「🤖 总结」打开；打开时自动**扫描本页**，
  把当前页面（含论坛自带搜索结果页/版面页）里的帖子列出来勾选。
- 输入「总结主题」→ 点「开始总结」，串行、限速地抓取楼层正文（UBB 已清洗为纯文本），
  DeepSeek 生成时**实时流式显示**在面板里，可直接阅读、一键复制 Markdown。

## 安装

1. 打开 Chrome，访问 `chrome://extensions`。
2. 右上角打开「开发者模式」。
3. 点「加载已解压的扩展程序」，选择本文件夹（`cc98-ai-summarizer`）。
4. 点扩展图标 → 「打开选项配置」，填入 **DeepSeek API Key**（模型默认 `deepseek-chat`，可在 [DeepSeek 开放平台](https://platform.deepseek.com/) 申请）。

## 登录令牌说明

插件**自动捕获**你在 cc98.org 浏览时使用的登录令牌：后台只读观察页面发往 `api.cc98.org`
的请求头里的 `Authorization: Bearer …`（不拦截、不修改、不重新登录、不存账号密码）。
打开任意 cc98 页面正常浏览几秒，面板顶行就会显示「已就绪：用户名」。

- 令牌过期后再次浏览 cc98 页面会自动重新捕获（页面刷新会重新发请求）。
- 手动兜底：选项页可粘贴 F12 → Network → `api.cc98.org` 请求里的 `authorization: Bearer …` 整串。

## 防封号 / 速度限制

- 全程 **串行**：同一时刻只有 1 个请求，绝不并发。
- 每次请求间隔 = 基础间隔 + 随机抖动（默认 3s + 0~3s），模拟真人阅读。
- 触发限流（HTTP 429/403/5xx）自动**指数退避**重试，连续失败自动暂停并提示。
- 每帖限制翻页数、总字符数上限，避免超长请求。
- 复用浏览器真实会话 + 真实 UA，与正常浏览无法区分。
- 所有参数可在「选项」页调整（间隔越大越安全）。

> 免责声明：请遵守 CC98 论坛规则，仅用于个人阅读与整理，不要高频批量抓取或二次传播。

## 目录结构

```
manifest.json     # MV3 清单（权限、host、后台、内容脚本）
background.js     # Service Worker：令牌捕获/限速爬取/UBB清洗/流式DeepSeek
content.js        # 悬浮面板 UI + 令牌自动检测
content.css       # 面板样式
options.html/js   # 配置页（AI + 限速参数）
popup.html/js     # 快捷入口与状态
```

## 技术要点

- 使用 cc98 官方 REST API（`api.cc98.org`，OpenID Bearer 认证）：
  - 帖子元信息：`GET /topic/{id}`
  - 楼层：`GET /Topic/{id}/post?from=&size=`（返回 UBB 正文，`replyCount+1` 为总楼层）
- UBB 清洗逻辑参考 [cc98-mcp](https://github.com/EviterLesRoses2/cc98-mcp)（MIT）。
