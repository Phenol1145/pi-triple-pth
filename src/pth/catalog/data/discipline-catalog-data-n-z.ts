/**
 * GENERATED FILE — 请勿手改。
 *
 * 生成源：docs/pth/design/n16-v1.2-role-expansion.md §2.1–§2.5
 * （只取 | id | 3/4/5 | parent | 职责 | 行；§2.6 非 researcher 不导入）
 * + src/pth/catalog/data/discipline-alias-overrides.ts（生产别名覆盖，F4 AB-06）。
 * 生成命令：npx tsx scripts/gen/build-discipline-catalog.ts
 * 数量断言（manifest 复算）：category=5、discipline=32、
 *   sub-discipline=147、total=184。
 */
import type { DomainDefinition } from "@away_from/pth-contracts";

export const DISCIPLINE_DEFINITIONS_N_Z: DomainDefinition[] = [
  {
    "id": "natural-science",
    "names": {
      "zh-CN": "自然科学门类",
      "en": "natural-science"
    },
    "aliases": [],
    "parents": [],
    "level": "category",
    "description": "自然科学门类——物理/化学/生物/地球/空间的中层",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "networks",
    "names": {
      "zh-CN": "计算机网络：协议/TCP-IP/分布式系统",
      "en": "networks"
    },
    "aliases": [],
    "parents": [
      "computer-science"
    ],
    "level": "sub-discipline",
    "description": "计算机网络：协议/TCP-IP/分布式系统",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "neuroscience",
    "names": {
      "zh-CN": "神经科学：神经元/脑区/突触/认知神经",
      "en": "neuroscience"
    },
    "aliases": [],
    "parents": [
      "psychology"
    ],
    "level": "sub-discipline",
    "description": "神经科学：神经元/脑区/突触/认知神经",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "new-media",
    "names": {
      "zh-CN": "新媒体：社交网络/数字内容/平台/算法文化",
      "en": "new-media"
    },
    "aliases": [],
    "parents": [
      "media-communication"
    ],
    "level": "sub-discipline",
    "description": "新媒体：社交网络/数字内容/平台/算法文化",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "number-theory",
    "names": {
      "zh-CN": "数论：初等数论/解析数论/代数数论",
      "en": "number-theory"
    },
    "aliases": [],
    "parents": [
      "mathematics"
    ],
    "level": "sub-discipline",
    "description": "数论：初等数论/解析数论/代数数论",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "nursing",
    "names": {
      "zh-CN": "护理学：基础护理/专科护理/护理管理/康复",
      "en": "nursing"
    },
    "aliases": [],
    "parents": [
      "medicine"
    ],
    "level": "sub-discipline",
    "description": "护理学：基础护理/专科护理/护理管理/康复",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "oceanography",
    "names": {
      "zh-CN": "海洋学：洋流/海洋化学/海洋生物/海底地质",
      "en": "oceanography"
    },
    "aliases": [],
    "parents": [
      "earth-science"
    ],
    "level": "sub-discipline",
    "description": "海洋学：洋流/海洋化学/海洋生物/海底地质",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "operating-systems",
    "names": {
      "zh-CN": "操作系统：内核/调度/文件系统/虚拟化",
      "en": "operating-systems"
    },
    "aliases": [],
    "parents": [
      "computer-science"
    ],
    "level": "sub-discipline",
    "description": "操作系统：内核/调度/文件系统/虚拟化",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "optics",
    "names": {
      "zh-CN": "光学：几何光学/物理光学/量子光学",
      "en": "optics"
    },
    "aliases": [],
    "parents": [
      "physics"
    ],
    "level": "sub-discipline",
    "description": "光学：几何光学/物理光学/量子光学",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "organic-chemistry",
    "names": {
      "zh-CN": "有机化学：碳化合物/合成/机理",
      "en": "organic-chemistry"
    },
    "aliases": [],
    "parents": [
      "chemistry"
    ],
    "level": "sub-discipline",
    "description": "有机化学：碳化合物/合成/机理",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "particle-physics",
    "names": {
      "zh-CN": "粒子物理：标准模型/量子场论/高能物理",
      "en": "particle-physics"
    },
    "aliases": [],
    "parents": [
      "physics"
    ],
    "level": "sub-discipline",
    "description": "粒子物理：标准模型/量子场论/高能物理",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "performing-arts",
    "names": {
      "zh-CN": "表演艺术：戏剧/舞蹈/音乐/歌剧",
      "en": "performing-arts"
    },
    "aliases": [],
    "parents": [
      "arts"
    ],
    "level": "sub-discipline",
    "description": "表演艺术：戏剧/舞蹈/音乐/歌剧",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "pharmacy",
    "names": {
      "zh-CN": "药学：药物化学/药剂/药理学/临床药学",
      "en": "pharmacy"
    },
    "aliases": [],
    "parents": [
      "medicine"
    ],
    "level": "sub-discipline",
    "description": "药学：药物化学/药剂/药理学/临床药学",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "philosophical-logic",
    "names": {
      "zh-CN": "哲学逻辑：模态逻辑/时序逻辑/道义逻辑",
      "en": "philosophical-logic"
    },
    "aliases": [],
    "parents": [
      "logic"
    ],
    "level": "sub-discipline",
    "description": "哲学逻辑：模态逻辑/时序逻辑/道义逻辑",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "philosophy",
    "names": {
      "zh-CN": "哲学",
      "en": "philosophy"
    },
    "aliases": [],
    "parents": [
      "humanities"
    ],
    "level": "discipline",
    "description": "哲学——存在与知识的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "phonology",
    "names": {
      "zh-CN": "音系学：音位/音节/韵律/音系规则",
      "en": "phonology"
    },
    "aliases": [],
    "parents": [
      "linguistics"
    ],
    "level": "sub-discipline",
    "description": "音系学：音位/音节/韵律/音系规则",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "physical-anthropology",
    "names": {
      "zh-CN": "体质人类学：人类演化/化石/灵长类/古人类",
      "en": "physical-anthropology"
    },
    "aliases": [],
    "parents": [
      "anthropology"
    ],
    "level": "sub-discipline",
    "description": "体质人类学：人类演化/化石/灵长类/古人类",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "physical-chemistry",
    "names": {
      "zh-CN": "物理化学：热力学/动力学/量子化学",
      "en": "physical-chemistry"
    },
    "aliases": [],
    "parents": [
      "chemistry"
    ],
    "level": "sub-discipline",
    "description": "物理化学：热力学/动力学/量子化学",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "physical-geography",
    "names": {
      "zh-CN": "自然地理：地貌/气候/水文/土壤",
      "en": "physical-geography"
    },
    "aliases": [],
    "parents": [
      "geography"
    ],
    "level": "sub-discipline",
    "description": "自然地理：地貌/气候/水文/土壤",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "physics",
    "names": {
      "zh-CN": "物理学",
      "en": "physics"
    },
    "aliases": [],
    "parents": [
      "natural-science"
    ],
    "level": "discipline",
    "description": "物理学——物质与能量的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "political-science",
    "names": {
      "zh-CN": "政治学",
      "en": "political-science"
    },
    "aliases": [],
    "parents": [
      "social-science"
    ],
    "level": "discipline",
    "description": "政治学——权力与治理的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "political-sociology",
    "names": {
      "zh-CN": "政治社会学：权力/国家/社会运动/公民",
      "en": "political-sociology"
    },
    "aliases": [],
    "parents": [
      "sociology"
    ],
    "level": "sub-discipline",
    "description": "政治社会学：权力/国家/社会运动/公民",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "political-theory",
    "names": {
      "zh-CN": "政治理论：正义/自由/平等/权力/契约",
      "en": "political-theory"
    },
    "aliases": [],
    "parents": [
      "political-science"
    ],
    "level": "sub-discipline",
    "description": "政治理论：正义/自由/平等/权力/契约",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "polymer-chemistry",
    "names": {
      "zh-CN": "高分子化学：聚合/塑料/橡胶/纤维",
      "en": "polymer-chemistry"
    },
    "aliases": [],
    "parents": [
      "chemistry"
    ],
    "level": "sub-discipline",
    "description": "高分子化学：聚合/塑料/橡胶/纤维",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "probability",
    "names": {
      "zh-CN": "概率论：随机过程/测度论/极限定理",
      "en": "probability"
    },
    "aliases": [],
    "parents": [
      "mathematics"
    ],
    "level": "sub-discipline",
    "description": "概率论：随机过程/测度论/极限定理",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "programming-languages",
    "names": {
      "zh-CN": "编程语言：类型论/编译器/程序分析",
      "en": "programming-languages"
    },
    "aliases": [
      "编程语言",
      "类型系统",
      "编译器",
      "程序分析",
      "类型检查",
      "中间表示",
      "语言规范"
    ],
    "parents": [
      "computer-science"
    ],
    "level": "sub-discipline",
    "description": "编程语言：类型论/编译器/程序分析",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "psychology",
    "names": {
      "zh-CN": "心理学",
      "en": "psychology"
    },
    "aliases": [],
    "parents": [
      "social-science"
    ],
    "level": "discipline",
    "description": "心理学——心智与行为的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "public-administration",
    "names": {
      "zh-CN": "公共行政：官僚/政策执行/公共管理/治理",
      "en": "public-administration"
    },
    "aliases": [],
    "parents": [
      "political-science"
    ],
    "level": "sub-discipline",
    "description": "公共行政：官僚/政策执行/公共管理/治理",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "public-health",
    "names": {
      "zh-CN": "公共卫生：流行病学/卫生政策/预防/健康促进",
      "en": "public-health"
    },
    "aliases": [],
    "parents": [
      "medicine"
    ],
    "level": "sub-discipline",
    "description": "公共卫生：流行病学/卫生政策/预防/健康促进",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "quantum-mechanics",
    "names": {
      "zh-CN": "量子力学：波函数/算符/纠缠/测量",
      "en": "quantum-mechanics"
    },
    "aliases": [],
    "parents": [
      "physics"
    ],
    "level": "sub-discipline",
    "description": "量子力学：波函数/算符/纠缠/测量",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "relativity",
    "names": {
      "zh-CN": "相对论：狭义/广义/引力波/时空",
      "en": "relativity"
    },
    "aliases": [],
    "parents": [
      "physics"
    ],
    "level": "sub-discipline",
    "description": "相对论：狭义/广义/引力波/时空",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "religious-studies",
    "names": {
      "zh-CN": "宗教研究",
      "en": "religious-studies"
    },
    "aliases": [],
    "parents": [
      "humanities"
    ],
    "level": "discipline",
    "description": "宗教研究——信仰与神圣的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "semantics",
    "names": {
      "zh-CN": "语义学：词汇语义/形式语义/语用学",
      "en": "semantics"
    },
    "aliases": [],
    "parents": [
      "linguistics"
    ],
    "level": "sub-discipline",
    "description": "语义学：词汇语义/形式语义/语用学",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "sexology",
    "names": {
      "zh-CN": "性学",
      "en": "sexology"
    },
    "aliases": [],
    "parents": [
      "social-science"
    ],
    "level": "discipline",
    "description": "性学——人类性行为与性别的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "social-psychology",
    "names": {
      "zh-CN": "社会心理学：态度/从众/偏见/群体",
      "en": "social-psychology"
    },
    "aliases": [],
    "parents": [
      "psychology"
    ],
    "level": "sub-discipline",
    "description": "社会心理学：态度/从众/偏见/群体",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "social-science",
    "names": {
      "zh-CN": "社会科学门类",
      "en": "social-science"
    },
    "aliases": [],
    "parents": [],
    "level": "category",
    "description": "社会科学门类——经济/社会/心理/政治/人类/语言/地理/历史的中层",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "social-stratification",
    "names": {
      "zh-CN": "社会分层：阶级/不平等/流动/教育",
      "en": "social-stratification"
    },
    "aliases": [],
    "parents": [
      "sociology"
    ],
    "level": "sub-discipline",
    "description": "社会分层：阶级/不平等/流动/教育",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "sociolinguistics",
    "names": {
      "zh-CN": "社会语言学：方言/语言变异/语言政策/双语",
      "en": "sociolinguistics"
    },
    "aliases": [],
    "parents": [
      "linguistics"
    ],
    "level": "sub-discipline",
    "description": "社会语言学：方言/语言变异/语言政策/双语",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "sociology",
    "names": {
      "zh-CN": "社会学",
      "en": "sociology"
    },
    "aliases": [],
    "parents": [
      "social-science"
    ],
    "level": "discipline",
    "description": "社会学——社会结构与行为的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "software-engineering",
    "names": {
      "zh-CN": "软件工程：架构/设计模式/DevOps/质量保证",
      "en": "software-engineering"
    },
    "aliases": [],
    "parents": [
      "computer-science"
    ],
    "level": "sub-discipline",
    "description": "软件工程：架构/设计模式/DevOps/质量保证",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "space-science",
    "names": {
      "zh-CN": "空间科学",
      "en": "space-science"
    },
    "aliases": [],
    "parents": [
      "natural-science"
    ],
    "level": "discipline",
    "description": "空间科学——宇宙与天体的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "statistics",
    "names": {
      "zh-CN": "统计学",
      "en": "statistics"
    },
    "aliases": [],
    "parents": [
      "formal-science"
    ],
    "level": "discipline",
    "description": "统计学——数据收集/分析/推断的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "strategy",
    "names": {
      "zh-CN": "战略学：大战略/军事战略/威慑/安全",
      "en": "strategy"
    },
    "aliases": [],
    "parents": [
      "military"
    ],
    "level": "sub-discipline",
    "description": "战略学：大战略/军事战略/威慑/安全",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "syntax",
    "names": {
      "zh-CN": "句法学：短语结构/依存/生成语法/构式",
      "en": "syntax"
    },
    "aliases": [],
    "parents": [
      "linguistics"
    ],
    "level": "sub-discipline",
    "description": "句法学：短语结构/依存/生成语法/构式",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "systems-science",
    "names": {
      "zh-CN": "系统科学",
      "en": "systems-science"
    },
    "aliases": [],
    "parents": [
      "formal-science"
    ],
    "level": "discipline",
    "description": "系统科学——系统与控制的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "tactics",
    "names": {
      "zh-CN": "战术学：作战/机动/火力/指挥",
      "en": "tactics"
    },
    "aliases": [],
    "parents": [
      "military"
    ],
    "level": "sub-discipline",
    "description": "战术学：作战/机动/火力/指挥",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "theology",
    "names": {
      "zh-CN": "神学：系统神学/圣经/教义/护教学",
      "en": "theology"
    },
    "aliases": [],
    "parents": [
      "religious-studies"
    ],
    "level": "sub-discipline",
    "description": "神学：系统神学/圣经/教义/护教学",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "theoretical-linguistics",
    "names": {
      "zh-CN": "理论语言学：普遍语法/类型学/语言共性",
      "en": "theoretical-linguistics"
    },
    "aliases": [],
    "parents": [
      "linguistics"
    ],
    "level": "sub-discipline",
    "description": "理论语言学：普遍语法/类型学/语言共性",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "thermodynamics",
    "names": {
      "zh-CN": "热力学：热/功/熵/统计力学",
      "en": "thermodynamics"
    },
    "aliases": [],
    "parents": [
      "physics"
    ],
    "level": "sub-discipline",
    "description": "热力学：热/功/熵/统计力学",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "topology",
    "names": {
      "zh-CN": "拓扑学：点集拓扑/代数拓扑/微分拓扑",
      "en": "topology"
    },
    "aliases": [],
    "parents": [
      "mathematics"
    ],
    "level": "sub-discipline",
    "description": "拓扑学：点集拓扑/代数拓扑/微分拓扑",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "urban-planning",
    "names": {
      "zh-CN": "城市规划：土地利用/交通/社区/可持续发展",
      "en": "urban-planning"
    },
    "aliases": [],
    "parents": [
      "architecture"
    ],
    "level": "sub-discipline",
    "description": "城市规划：土地利用/交通/社区/可持续发展",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "urban-sociology",
    "names": {
      "zh-CN": "城市社会学：城市化/社区/空间/隔离",
      "en": "urban-sociology"
    },
    "aliases": [],
    "parents": [
      "sociology"
    ],
    "level": "sub-discipline",
    "description": "城市社会学：城市化/社区/空间/隔离",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "visual-arts",
    "names": {
      "zh-CN": "视觉艺术：绘画/雕塑/摄影/装置",
      "en": "visual-arts"
    },
    "aliases": [],
    "parents": [
      "arts"
    ],
    "level": "sub-discipline",
    "description": "视觉艺术：绘画/雕塑/摄影/装置",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "western-philosophy",
    "names": {
      "zh-CN": "西方哲学：古希腊/近代/分析/欧陆",
      "en": "western-philosophy"
    },
    "aliases": [],
    "parents": [
      "philosophy"
    ],
    "level": "sub-discipline",
    "description": "西方哲学：古希腊/近代/分析/欧陆",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "world-history",
    "names": {
      "zh-CN": "世界史：全球史/比较史/跨区域/文明",
      "en": "world-history"
    },
    "aliases": [],
    "parents": [
      "history"
    ],
    "level": "sub-discipline",
    "description": "世界史：全球史/比较史/跨区域/文明",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "zoology",
    "names": {
      "zh-CN": "动物学：分类/行为/生理/保护",
      "en": "zoology"
    },
    "aliases": [],
    "parents": [
      "biology"
    ],
    "level": "sub-discipline",
    "description": "动物学：分类/行为/生理/保护",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  }
];
