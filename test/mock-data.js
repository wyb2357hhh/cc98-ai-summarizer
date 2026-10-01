// ============================================================================
// CC98 AI 总结 —— 模拟测试数据
// 形状对齐官方 API 返回值（topic 列表 / 帖子楼层），供离线联调与单元测试。
// ============================================================================

// 搜索接口返回的 topic 列表（形状同 background.js 的 apiSearch 映射结果）
const MOCK_SEARCH_RESULTS = [
  { id: 1001, title: "计院研究生毕业都去哪了？", boardName: "就业", author: "匿名", replyCount: 42, time: "2025-01-12" },
  { id: 1002, title: "CS硕士大厂还是国企？求建议", boardName: "就业", author: "zju_cs", replyCount: 28, time: "2025-03-05" },
  { id: 1003, title: "今年计算机秋招行情怎么样", boardName: "水木清华", author: "匿名", replyCount: 66, time: "2024-09-20" },
  { id: 1004, title: "算法岗 vs 开发岗 选择困难", boardName: "就业", author: "lz98", replyCount: 19, time: "2025-02-18" },
  { id: 1005, title: "考研还是直接就业？", boardName: "考研", author: "匿名", replyCount: 35, time: "2024-12-01" },
  { id: 1006, title: "转码上岸经验分享", boardName: "经验分享", author: "code_new", replyCount: 12, time: "2025-04-02" }
];

// 单个主题帖的元信息（topic 接口返回）
const MOCK_TOPIC = {
  id: 1001,
  title: "计院研究生毕业都去哪了？",
  boardId: 520,
  boardName: "就业",
  userName: "匿名",
  isAnonymous: true,
  replyCount: 9,      // 楼层数 = replyCount + 1
  hitCount: 1200,
  likeCount: 15,
  time: "2025-01-12 10:00:00",
  lastPostTime: "2025-06-01 22:30:00"
};

// 楼层正文（UBB 格式），覆盖常见的 UBB 标记，用于测试 ubbToText
const MOCK_POSTS = [
  {
    floor: 1, userName: "匿名", isAnonymous: true, time: "2025-01-12 10:00:00",
    isDeleted: false, likeCount: 15,
    content: "[size=5][b]开个帖子问问[/b][/size]\n今年计算机硕士毕业的学长学姐都去哪了？[color=red]求真实数据[/color]，不要画饼。"
  },
  {
    floor: 2, userName: "zju_cs", isAnonymous: false, time: "2025-01-12 10:30:00",
    isDeleted: false, likeCount: 8,
    content: "[quote][b]楼主[/b] 说到：\n今年计算机硕士毕业的学长学姐都去哪了？[/quote]\n周围去大厂的多，[url=https://www.cc98.org/topic/1001]看这个帖[/url]里统计过。"
  },
  {
    floor: 3, userName: "匿名", isAnonymous: true, time: "2025-01-12 11:00:00",
    isDeleted: false, likeCount: 20,
    content: "贴一张去向图：[img]https://img.cc98.org/xxx.png[/img]\n还有宣讲会录屏 [video]https://video.cc98.org/yyy.mp4[/video]"
  },
  {
    floor: 4, userName: "offer_king", isAnonymous: false, time: "2025-01-12 11:20:00",
    isDeleted: false, likeCount: 3,
    content: "[color=blue]个人观点[/color]：国企稳定但涨薪慢，大厂累但成长快。\n[align=center]关键看你要什么[/align]"
  },
  {
    floor: 5, userName: "匿名", isAnonymous: true, time: "2025-01-12 12:00:00",
    isDeleted: false, likeCount: 1,
    content: "附件里放了整理好的去向表：[upload=2]https://file.cc98.org/去向表.xlsx[/upload]"
  },
  {
    floor: 6, userName: "deleted_user", isAnonymous: false, time: "2025-01-12 13:00:00",
    isDeleted: true, likeCount: 0, content: ""
  },
  {
    floor: 7, userName: "路人甲", isAnonymous: false, time: "2025-01-12 13:30:00",
    isDeleted: false, likeCount: 0,
    content: "赞一个[ac01] 围观中[em02][tb01][ms01]"
  },
  {
    floor: 8, userName: "匿名", isAnonymous: true, time: "2025-01-12 14:00:00",
    isDeleted: false, likeCount: 5,
    content: "[url]https://www.cc98.org/topic/1001[/url]\n补充：部分人去做了量化/芯片/自动驾驶，方向很杂。"
  },
  {
    floor: 9, userName: "老学长", isAnonymous: false, time: "2025-01-12 15:00:00",
    isDeleted: false, likeCount: 12,
    content: "总结一句：[b][i]别只看起薪[/i][/b]，看平台和成长空间。\n[line]\n此楼已被版主标记为精华。"
  }
];

// 关键词拆解（generateKeywords）的期望示例
const MOCK_KEYWORDS = ["计算机就业", "硕士去向", "大厂", "国企", "算法岗", "CS就业"];

// AI 搜索答案的 Markdown 示例（用于测试 mdToHtml 渲染）
const MOCK_AI_ANSWER = `## 核心观点
- 计算机硕士去向以**大厂为主**，国企、量化、芯片等为辅。
- 多数人建议"别只看起薪，看平台与成长"（见 9 楼）。

### 不同立场
1. 大厂派：成长快、薪资高，但累。
2. 国企派：稳定、性价比高，但涨薪慢（见 4 楼）。

> 引用：\`关键看你要什么\` —— 4 楼

\`\`\`
数据来自 5 楼附件《去向表.xlsx》
\`\`\`
`;

// 供 Node 环境导入
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MOCK_SEARCH_RESULTS, MOCK_TOPIC, MOCK_POSTS, MOCK_KEYWORDS, MOCK_AI_ANSWER
  };
}
