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

export const DISCIPLINE_DEFINITIONS_G_M: DomainDefinition[] = [
  {
    "id": "genetics",
    "names": {
      "zh-CN": "遗传学：孟德尔/群体/数量/表观遗传",
      "en": "genetics"
    },
    "aliases": [],
    "parents": [
      "biology"
    ],
    "level": "sub-discipline",
    "description": "遗传学：孟德尔/群体/数量/表观遗传",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "geography",
    "names": {
      "zh-CN": "地理学",
      "en": "geography"
    },
    "aliases": [],
    "parents": [
      "social-science"
    ],
    "level": "discipline",
    "description": "地理学——空间与地方的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "geology",
    "names": {
      "zh-CN": "地质学：矿物/岩石/构造/地震",
      "en": "geology"
    },
    "aliases": [],
    "parents": [
      "earth-science"
    ],
    "level": "sub-discipline",
    "description": "地质学：矿物/岩石/构造/地震",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "geometry",
    "names": {
      "zh-CN": "几何学：欧氏几何/微分几何/代数几何",
      "en": "geometry"
    },
    "aliases": [],
    "parents": [
      "mathematics"
    ],
    "level": "sub-discipline",
    "description": "几何学：欧氏几何/微分几何/代数几何",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "gis",
    "names": {
      "zh-CN": "地理信息系统：空间分析/遥感/制图",
      "en": "gis"
    },
    "aliases": [],
    "parents": [
      "geography"
    ],
    "level": "sub-discipline",
    "description": "地理信息系统：空间分析/遥感/制图",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "historiography",
    "names": {
      "zh-CN": "史学史：史学理论/方法/史料/历史书写",
      "en": "historiography"
    },
    "aliases": [],
    "parents": [
      "history"
    ],
    "level": "sub-discipline",
    "description": "史学史：史学理论/方法/史料/历史书写",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "history",
    "names": {
      "zh-CN": "历史学",
      "en": "history"
    },
    "aliases": [],
    "parents": [
      "social-science"
    ],
    "level": "discipline",
    "description": "历史学——过去事件与过程的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "human-geography",
    "names": {
      "zh-CN": "人文地理：城市/经济/文化/政治地理",
      "en": "human-geography"
    },
    "aliases": [],
    "parents": [
      "geography"
    ],
    "level": "sub-discipline",
    "description": "人文地理：城市/经济/文化/政治地理",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "human-resources",
    "names": {
      "zh-CN": "人力资源：招聘/绩效/培训/劳动关系",
      "en": "human-resources"
    },
    "aliases": [],
    "parents": [
      "business"
    ],
    "level": "sub-discipline",
    "description": "人力资源：招聘/绩效/培训/劳动关系",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "humanities",
    "names": {
      "zh-CN": "人文学科门类",
      "en": "humanities"
    },
    "aliases": [],
    "parents": [],
    "level": "category",
    "description": "人文学科门类——文学/哲学/艺术/宗教/区域的中层",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "information-theory",
    "names": {
      "zh-CN": "信息论：熵/编码/压缩/信道容量",
      "en": "information-theory"
    },
    "aliases": [],
    "parents": [
      "systems-science"
    ],
    "level": "sub-discipline",
    "description": "信息论：熵/编码/压缩/信道容量",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "inorganic-chemistry",
    "names": {
      "zh-CN": "无机化学：元素/配位/晶体/金属有机",
      "en": "inorganic-chemistry"
    },
    "aliases": [],
    "parents": [
      "chemistry"
    ],
    "level": "sub-discipline",
    "description": "无机化学：元素/配位/晶体/金属有机",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "international-economics",
    "names": {
      "zh-CN": "国际经济学：贸易/汇率/资本流动/全球化",
      "en": "international-economics"
    },
    "aliases": [],
    "parents": [
      "economics"
    ],
    "level": "sub-discipline",
    "description": "国际经济学：贸易/汇率/资本流动/全球化",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "international-relations",
    "names": {
      "zh-CN": "国际关系：战争/和平/外交/国际组织",
      "en": "international-relations"
    },
    "aliases": [],
    "parents": [
      "political-science"
    ],
    "level": "sub-discipline",
    "description": "国际关系：战争/和平/外交/国际组织",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "journalism",
    "names": {
      "zh-CN": "新闻学：报道/编辑/调查/数据新闻",
      "en": "journalism"
    },
    "aliases": [],
    "parents": [
      "media-communication"
    ],
    "level": "sub-discipline",
    "description": "新闻学：报道/编辑/调查/数据新闻",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "landscape-architecture",
    "names": {
      "zh-CN": "景观设计：园林/开放空间/生态设计",
      "en": "landscape-architecture"
    },
    "aliases": [],
    "parents": [
      "architecture"
    ],
    "level": "sub-discipline",
    "description": "景观设计：园林/开放空间/生态设计",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "linguistic-anthropology",
    "names": {
      "zh-CN": "语言人类学：语言与文化/话语/语言接触",
      "en": "linguistic-anthropology"
    },
    "aliases": [],
    "parents": [
      "anthropology"
    ],
    "level": "sub-discipline",
    "description": "语言人类学：语言与文化/话语/语言接触",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "linguistics",
    "names": {
      "zh-CN": "语言学",
      "en": "linguistics"
    },
    "aliases": [],
    "parents": [
      "social-science"
    ],
    "level": "discipline",
    "description": "语言学——语言结构与使用的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "literary-theory",
    "names": {
      "zh-CN": "文学理论：叙事学/接受美学/解构/后殖民",
      "en": "literary-theory"
    },
    "aliases": [],
    "parents": [
      "literature"
    ],
    "level": "sub-discipline",
    "description": "文学理论：叙事学/接受美学/解构/后殖民",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "literature",
    "names": {
      "zh-CN": "文学",
      "en": "literature"
    },
    "aliases": [],
    "parents": [
      "humanities"
    ],
    "level": "discipline",
    "description": "文学——语言艺术与文本的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "logic",
    "names": {
      "zh-CN": "逻辑学",
      "en": "logic"
    },
    "aliases": [],
    "parents": [
      "formal-science"
    ],
    "level": "discipline",
    "description": "逻辑学——推理与证明的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "macroeconomics",
    "names": {
      "zh-CN": "宏观经济学：GDP/通胀/失业/货币政策",
      "en": "macroeconomics"
    },
    "aliases": [],
    "parents": [
      "economics"
    ],
    "level": "sub-discipline",
    "description": "宏观经济学：GDP/通胀/失业/货币政策",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "management",
    "names": {
      "zh-CN": "管理学：战略/组织行为/运营/供应链",
      "en": "management"
    },
    "aliases": [],
    "parents": [
      "business"
    ],
    "level": "sub-discipline",
    "description": "管理学：战略/组织行为/运营/供应链",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "marketing",
    "names": {
      "zh-CN": "市场营销：消费者行为/品牌/数字营销/定价",
      "en": "marketing"
    },
    "aliases": [],
    "parents": [
      "business"
    ],
    "level": "sub-discipline",
    "description": "市场营销：消费者行为/品牌/数字营销/定价",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "materials-science",
    "names": {
      "zh-CN": "材料科学：金属/陶瓷/高分子/复合材料",
      "en": "materials-science"
    },
    "aliases": [
      "材料科学",
      "固态电解质",
      "离子电导率",
      "电化学稳定窗口",
      "材料数据库",
      "Materials Project",
      "NOMAD"
    ],
    "parents": [
      "engineering"
    ],
    "level": "sub-discipline",
    "description": "材料科学：金属/陶瓷/高分子/复合材料",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "mathematical-logic",
    "names": {
      "zh-CN": "数理逻辑：模型论/证明论/递归论/集合论",
      "en": "mathematical-logic"
    },
    "aliases": [],
    "parents": [
      "logic"
    ],
    "level": "sub-discipline",
    "description": "数理逻辑：模型论/证明论/递归论/集合论",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "mathematical-statistics",
    "names": {
      "zh-CN": "数理统计：估计理论/假设检验/渐近理论",
      "en": "mathematical-statistics"
    },
    "aliases": [],
    "parents": [
      "statistics"
    ],
    "level": "sub-discipline",
    "description": "数理统计：估计理论/假设检验/渐近理论",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "mathematics",
    "names": {
      "zh-CN": "数学",
      "en": "mathematics"
    },
    "aliases": [],
    "parents": [
      "formal-science"
    ],
    "level": "discipline",
    "description": "数学——纯数与应用的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "mechanical-engineering",
    "names": {
      "zh-CN": "机械工程：动力/制造/机器人/热机",
      "en": "mechanical-engineering"
    },
    "aliases": [],
    "parents": [
      "engineering"
    ],
    "level": "sub-discipline",
    "description": "机械工程：动力/制造/机器人/热机",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "mechanics",
    "names": {
      "zh-CN": "力学：经典力学/连续介质力学/流体力学",
      "en": "mechanics"
    },
    "aliases": [],
    "parents": [
      "physics"
    ],
    "level": "sub-discipline",
    "description": "力学：经典力学/连续介质力学/流体力学",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "media-communication",
    "names": {
      "zh-CN": "传媒",
      "en": "media-communication"
    },
    "aliases": [],
    "parents": [
      "applied-science"
    ],
    "level": "discipline",
    "description": "传媒——信息传播的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "medicine",
    "names": {
      "zh-CN": "医学",
      "en": "medicine"
    },
    "aliases": [],
    "parents": [
      "applied-science"
    ],
    "level": "discipline",
    "description": "医学——健康与疾病的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "metaphysics",
    "names": {
      "zh-CN": "形而上学：存在/本体/因果/时间/自由意志",
      "en": "metaphysics"
    },
    "aliases": [],
    "parents": [
      "philosophy"
    ],
    "level": "sub-discipline",
    "description": "形而上学：存在/本体/因果/时间/自由意志",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "meteorology",
    "names": {
      "zh-CN": "气象学：大气/气候/天气/预报",
      "en": "meteorology"
    },
    "aliases": [],
    "parents": [
      "earth-science"
    ],
    "level": "sub-discipline",
    "description": "气象学：大气/气候/天气/预报",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "microbiology",
    "names": {
      "zh-CN": "微生物学：细菌/病毒/真菌/免疫",
      "en": "microbiology"
    },
    "aliases": [],
    "parents": [
      "biology"
    ],
    "level": "sub-discipline",
    "description": "微生物学：细菌/病毒/真菌/免疫",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "microeconomics",
    "names": {
      "zh-CN": "微观经济学：消费者/厂商/市场/博弈论",
      "en": "microeconomics"
    },
    "aliases": [],
    "parents": [
      "economics"
    ],
    "level": "sub-discipline",
    "description": "微观经济学：消费者/厂商/市场/博弈论",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "middle-eastern-studies",
    "names": {
      "zh-CN": "中东研究：伊斯兰文明/阿拉伯/奥斯曼/当代中东",
      "en": "middle-eastern-studies"
    },
    "aliases": [],
    "parents": [
      "area-studies"
    ],
    "level": "sub-discipline",
    "description": "中东研究：伊斯兰文明/阿拉伯/奥斯曼/当代中东",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "military",
    "names": {
      "zh-CN": "军事学",
      "en": "military"
    },
    "aliases": [],
    "parents": [
      "applied-science"
    ],
    "level": "discipline",
    "description": "军事学——国防与战争的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "military-technology",
    "names": {
      "zh-CN": "军事技术：武器/装备/情报/网络战",
      "en": "military-technology"
    },
    "aliases": [],
    "parents": [
      "military"
    ],
    "level": "sub-discipline",
    "description": "军事技术：武器/装备/情报/网络战",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "modern-history",
    "names": {
      "zh-CN": "近代史：近代早期/工业革命/现代/当代",
      "en": "modern-history"
    },
    "aliases": [],
    "parents": [
      "history"
    ],
    "level": "sub-discipline",
    "description": "近代史：近代早期/工业革命/现代/当代",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "molecular-biology",
    "names": {
      "zh-CN": "分子生物学：DNA/RNA/转录/翻译/调控",
      "en": "molecular-biology"
    },
    "aliases": [],
    "parents": [
      "biology"
    ],
    "level": "sub-discipline",
    "description": "分子生物学：DNA/RNA/转录/翻译/调控",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "music",
    "names": {
      "zh-CN": "音乐学：作曲/理论/音乐史/民族音乐",
      "en": "music"
    },
    "aliases": [],
    "parents": [
      "arts"
    ],
    "level": "sub-discipline",
    "description": "音乐学：作曲/理论/音乐史/民族音乐",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "mythology",
    "names": {
      "zh-CN": "神话学：创世神话/英雄神话/仪式/原型",
      "en": "mythology"
    },
    "aliases": [],
    "parents": [
      "religious-studies"
    ],
    "level": "sub-discipline",
    "description": "神话学：创世神话/英雄神话/仪式/原型",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  }
];
