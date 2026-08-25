# agent-reach 扩展（PTH toolstore）

agent-reach 互联网调研路由扩展——封装本机 agent-reach skill 的零配置通道，供
spider-web / spider-github 角色通过 PTH 工具面调用。

## 结构
- plugin.json —— manifest（contracts.tools 声明 7 个工具；activation onStartup）
- index.ts —— 工厂实现（module.exports = factory(ctx)——ctx 标准通道 exec/http）

## 工具（reach.* 域）
| 工具 | 参数 | 后端 | 说明 |
|---|---|---|---|
| reach.webSearch | query, n?(1-20, 默认5) | mcporter → exa.web_search_exa（jina 兜底） | Exa 网页搜索；结构化/文本输出自适应 |
| reach.webRead | url | jina reader（r.jina.ai，免 key） | 通用网页阅读→markdown；超时30s |
| reach.ghSearch | query, sort?(stars/forks/updated/best-match), limit?(1-50, 默认10) | gh CLI | 仓库搜索；--json 结构化输出 |
| reach.biliSearch | query, n?(1-50, 默认10) | bili CLI | B站搜索 |
| reach.v2exHot | n?(1-100, 默认20) | V2EX 官方 API | 热门话题（title/url/replies/node） |
| reach.doctor | - | agent-reach CLI | 后端体检：激活后端/零配置通道/登录态平台提示 |
| reach.checkUpdate | - | agent-reach CLI | 版本检查 |

## 约束
- 登录态平台（twitter/reddit/xhs/facebook/instagram/linkedin）不在 v1 封装范围——doctor 返回提示走现有通道。
- 每个工具：bash/http 执行 + 超时保护（15-30s）+ 输出截断（64KB 结果上限 / 256KB exec 上限）。
- 不修改 ~/.agents/skills/agent-reach/（只读参照）。

## 自测
scripts/tools/ext-check.ts agent-reach（装载冒烟 + manifest 校验 + 类型检查）。
