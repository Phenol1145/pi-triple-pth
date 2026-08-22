/**
 * GENERATED FILE — 请勿手改。
 *
 * 生成源：docs/pth/n16-v1.2-role-expansion.md §2.1–§2.5
 * （只取 | id | 3/4/5 | parent | 职责 | 行；§2.6 非 researcher 不导入）
 * + src/pth/catalog/data/discipline-alias-overrides.ts（生产别名覆盖，F4 AB-06）。
 * 生成命令：npx tsx scripts/build-discipline-catalog.ts
 * 数量断言（manifest 复算）：category=5、discipline=32、
 *   sub-discipline=147、total=184。
 */
import type { DomainDefinition } from "@away_from/pth-contracts";

export const DISCIPLINE_DEFINITIONS: DomainDefinition[] = [
  {
    "id": "accounting",
    "names": {
      "zh-CN": "会计学：财务/管理会计/审计/税务",
      "en": "accounting"
    },
    "aliases": [],
    "parents": [
      "business"
    ],
    "level": "sub-discipline",
    "description": "会计学：财务/管理会计/审计/税务",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "aerospace-engineering",
    "names": {
      "zh-CN": "航空航天：飞行器/推进/导航/空间系统",
      "en": "aerospace-engineering"
    },
    "aliases": [],
    "parents": [
      "engineering"
    ],
    "level": "sub-discipline",
    "description": "航空航天：飞行器/推进/导航/空间系统",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "aesthetics",
    "names": {
      "zh-CN": "美学：美/艺术/审美经验/趣味",
      "en": "aesthetics"
    },
    "aliases": [],
    "parents": [
      "philosophy"
    ],
    "level": "sub-discipline",
    "description": "美学：美/艺术/审美经验/趣味",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "african-studies",
    "names": {
      "zh-CN": "非洲研究：殖民/独立/发展/非洲文化/散居",
      "en": "african-studies"
    },
    "aliases": [],
    "parents": [
      "area-studies"
    ],
    "level": "sub-discipline",
    "description": "非洲研究：殖民/独立/发展/非洲文化/散居",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "agriculture",
    "names": {
      "zh-CN": "农业",
      "en": "agriculture"
    },
    "aliases": [],
    "parents": [
      "applied-science"
    ],
    "level": "discipline",
    "description": "农业——食物与纤维生产的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "agronomy",
    "names": {
      "zh-CN": "农学：作物/育种/土壤/耕作",
      "en": "agronomy"
    },
    "aliases": [],
    "parents": [
      "agriculture"
    ],
    "level": "sub-discipline",
    "description": "农学：作物/育种/土壤/耕作",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "algebra",
    "names": {
      "zh-CN": "代数学：群/环/域/线性代数/抽象代数",
      "en": "algebra"
    },
    "aliases": [],
    "parents": [
      "mathematics"
    ],
    "level": "sub-discipline",
    "description": "代数学：群/环/域/线性代数/抽象代数",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "algorithms",
    "names": {
      "zh-CN": "算法与数据结构：复杂度/图算法/近似算法",
      "en": "algorithms"
    },
    "aliases": [],
    "parents": [
      "computer-science"
    ],
    "level": "sub-discipline",
    "description": "算法与数据结构：复杂度/图算法/近似算法",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "analysis",
    "names": {
      "zh-CN": "分析学：实分析/复分析/泛函分析",
      "en": "analysis"
    },
    "aliases": [],
    "parents": [
      "mathematics"
    ],
    "level": "sub-discipline",
    "description": "分析学：实分析/复分析/泛函分析",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "analytical-chemistry",
    "names": {
      "zh-CN": "分析化学：色谱/质谱/光谱/电化学分析",
      "en": "analytical-chemistry"
    },
    "aliases": [],
    "parents": [
      "chemistry"
    ],
    "level": "sub-discipline",
    "description": "分析化学：色谱/质谱/光谱/电化学分析",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "ancient-history",
    "names": {
      "zh-CN": "古代史：上古/古典/中古/断代",
      "en": "ancient-history"
    },
    "aliases": [],
    "parents": [
      "history"
    ],
    "level": "sub-discipline",
    "description": "古代史：上古/古典/中古/断代",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "animal-science",
    "names": {
      "zh-CN": "畜牧学：遗传育种/营养/繁殖/管理",
      "en": "animal-science"
    },
    "aliases": [],
    "parents": [
      "agriculture"
    ],
    "level": "sub-discipline",
    "description": "畜牧学：遗传育种/营养/繁殖/管理",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "anthropology",
    "names": {
      "zh-CN": "人类学",
      "en": "anthropology"
    },
    "aliases": [],
    "parents": [
      "social-science"
    ],
    "level": "discipline",
    "description": "人类学——人类文化与演化的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "applied-science",
    "names": {
      "zh-CN": "应用科学门类",
      "en": "applied-science"
    },
    "aliases": [],
    "parents": [],
    "level": "category",
    "description": "应用科学门类——工程/医学/农业/建筑/传媒/教育/商业/军事的中层",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "applied-statistics",
    "names": {
      "zh-CN": "应用统计：回归/方差分析/实验设计",
      "en": "applied-statistics"
    },
    "aliases": [],
    "parents": [
      "statistics"
    ],
    "level": "sub-discipline",
    "description": "应用统计：回归/方差分析/实验设计",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "archaeology",
    "names": {
      "zh-CN": "考古学：史前/历史考古/文化遗产/科技考古",
      "en": "archaeology"
    },
    "aliases": [],
    "parents": [
      "anthropology"
    ],
    "level": "sub-discipline",
    "description": "考古学：史前/历史考古/文化遗产/科技考古",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "architectural-design",
    "names": {
      "zh-CN": "建筑设计：方案/空间/功能/形式",
      "en": "architectural-design"
    },
    "aliases": [],
    "parents": [
      "architecture"
    ],
    "level": "sub-discipline",
    "description": "建筑设计：方案/空间/功能/形式",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "architecture",
    "names": {
      "zh-CN": "建筑学",
      "en": "architecture"
    },
    "aliases": [],
    "parents": [
      "applied-science"
    ],
    "level": "discipline",
    "description": "建筑学——空间与环境的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "area-studies",
    "names": {
      "zh-CN": "区域研究",
      "en": "area-studies"
    },
    "aliases": [],
    "parents": [
      "humanities"
    ],
    "level": "discipline",
    "description": "区域研究——特定地域文明的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "artificial-intelligence",
    "names": {
      "zh-CN": "人工智能：机器学习/NLP/计算机视觉/规划",
      "en": "artificial-intelligence"
    },
    "aliases": [],
    "parents": [
      "computer-science"
    ],
    "level": "sub-discipline",
    "description": "人工智能：机器学习/NLP/计算机视觉/规划",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "arts",
    "names": {
      "zh-CN": "艺术",
      "en": "arts"
    },
    "aliases": [],
    "parents": [
      "humanities"
    ],
    "level": "discipline",
    "description": "艺术——审美创造与表达的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "astronomy",
    "names": {
      "zh-CN": "天文学：恒星/星系/行星/观测",
      "en": "astronomy"
    },
    "aliases": [],
    "parents": [
      "space-science"
    ],
    "level": "sub-discipline",
    "description": "天文学：恒星/星系/行星/观测",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "astrophysics",
    "names": {
      "zh-CN": "天体物理：恒星演化/黑洞/宇宙线/高能天体",
      "en": "astrophysics"
    },
    "aliases": [],
    "parents": [
      "space-science"
    ],
    "level": "sub-discipline",
    "description": "天体物理：恒星演化/黑洞/宇宙线/高能天体",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "basic-medicine",
    "names": {
      "zh-CN": "基础医学：解剖/生理/病理/药理/免疫",
      "en": "basic-medicine"
    },
    "aliases": [],
    "parents": [
      "medicine"
    ],
    "level": "sub-discipline",
    "description": "基础医学：解剖/生理/病理/药理/免疫",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "bayesian-statistics",
    "names": {
      "zh-CN": "贝叶斯统计：先验/后验/MCMC/层次模型",
      "en": "bayesian-statistics"
    },
    "aliases": [],
    "parents": [
      "statistics"
    ],
    "level": "sub-discipline",
    "description": "贝叶斯统计：先验/后验/MCMC/层次模型",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "behavioral-economics",
    "names": {
      "zh-CN": "行为经济学：有限理性/启发式/前景理论",
      "en": "behavioral-economics"
    },
    "aliases": [],
    "parents": [
      "economics"
    ],
    "level": "sub-discipline",
    "description": "行为经济学：有限理性/启发式/前景理论",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "biochemistry",
    "names": {
      "zh-CN": "生物化学：蛋白质/酶/代谢/核酸",
      "en": "biochemistry"
    },
    "aliases": [],
    "parents": [
      "chemistry"
    ],
    "level": "sub-discipline",
    "description": "生物化学：蛋白质/酶/代谢/核酸",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "biology",
    "names": {
      "zh-CN": "生物学",
      "en": "biology"
    },
    "aliases": [],
    "parents": [
      "natural-science"
    ],
    "level": "discipline",
    "description": "生物学——生命现象的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "biomedical-engineering",
    "names": {
      "zh-CN": "生物医学工程：影像/假体/组织工程/生物材料",
      "en": "biomedical-engineering"
    },
    "aliases": [],
    "parents": [
      "engineering"
    ],
    "level": "sub-discipline",
    "description": "生物医学工程：影像/假体/组织工程/生物材料",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "biostatistics",
    "names": {
      "zh-CN": "生物统计：临床试验/生存分析/流行病学统计",
      "en": "biostatistics"
    },
    "aliases": [],
    "parents": [
      "statistics"
    ],
    "level": "sub-discipline",
    "description": "生物统计：临床试验/生存分析/流行病学统计",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "botany",
    "names": {
      "zh-CN": "植物学：分类/生理/生态/分子植物",
      "en": "botany"
    },
    "aliases": [],
    "parents": [
      "biology"
    ],
    "level": "sub-discipline",
    "description": "植物学：分类/生理/生态/分子植物",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "buddhist-studies",
    "names": {
      "zh-CN": "佛学：经典/宗派/禅修/佛教史",
      "en": "buddhist-studies"
    },
    "aliases": [],
    "parents": [
      "religious-studies"
    ],
    "level": "sub-discipline",
    "description": "佛学：经典/宗派/禅修/佛教史",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "business",
    "names": {
      "zh-CN": "商学",
      "en": "business"
    },
    "aliases": [],
    "parents": [
      "applied-science"
    ],
    "level": "discipline",
    "description": "商学——组织与市场的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "cell-biology",
    "names": {
      "zh-CN": "细胞生物学：膜/器/信号转导/周期",
      "en": "cell-biology"
    },
    "aliases": [],
    "parents": [
      "biology"
    ],
    "level": "sub-discipline",
    "description": "细胞生物学：膜/器/信号转导/周期",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "chemical-engineering",
    "names": {
      "zh-CN": "化学工程：反应/分离/流程/催化",
      "en": "chemical-engineering"
    },
    "aliases": [],
    "parents": [
      "engineering"
    ],
    "level": "sub-discipline",
    "description": "化学工程：反应/分离/流程/催化",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "chemistry",
    "names": {
      "zh-CN": "化学",
      "en": "chemistry"
    },
    "aliases": [],
    "parents": [
      "natural-science"
    ],
    "level": "discipline",
    "description": "化学——物质组成与变化的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "chinese-literature",
    "names": {
      "zh-CN": "中国文学：古典/现当代/诗词/小说/戏曲",
      "en": "chinese-literature"
    },
    "aliases": [],
    "parents": [
      "literature"
    ],
    "level": "sub-discipline",
    "description": "中国文学：古典/现当代/诗词/小说/戏曲",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "chinese-philosophy",
    "names": {
      "zh-CN": "中国哲学：儒家/道家/墨家/法家/禅宗",
      "en": "chinese-philosophy"
    },
    "aliases": [],
    "parents": [
      "philosophy"
    ],
    "level": "sub-discipline",
    "description": "中国哲学：儒家/道家/墨家/法家/禅宗",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "civil-engineering",
    "names": {
      "zh-CN": "土木工程：结构/岩土/交通/水利",
      "en": "civil-engineering"
    },
    "aliases": [],
    "parents": [
      "engineering"
    ],
    "level": "sub-discipline",
    "description": "土木工程：结构/岩土/交通/水利",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "clinical-medicine",
    "names": {
      "zh-CN": "临床医学：内科/外科/诊断/治疗",
      "en": "clinical-medicine"
    },
    "aliases": [],
    "parents": [
      "medicine"
    ],
    "level": "sub-discipline",
    "description": "临床医学：内科/外科/诊断/治疗",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "clinical-psychology",
    "names": {
      "zh-CN": "临床心理学：诊断/治疗/心理评估/精神病理",
      "en": "clinical-psychology"
    },
    "aliases": [],
    "parents": [
      "psychology"
    ],
    "level": "sub-discipline",
    "description": "临床心理学：诊断/治疗/心理评估/精神病理",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "cognitive-psychology",
    "names": {
      "zh-CN": "认知心理学：知觉/注意/记忆/思维/语言",
      "en": "cognitive-psychology"
    },
    "aliases": [],
    "parents": [
      "psychology"
    ],
    "level": "sub-discipline",
    "description": "认知心理学：知觉/注意/记忆/思维/语言",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "communication-studies",
    "names": {
      "zh-CN": "传播学：大众传播/人际传播/媒介效果",
      "en": "communication-studies"
    },
    "aliases": [],
    "parents": [
      "media-communication"
    ],
    "level": "sub-discipline",
    "description": "传播学：大众传播/人际传播/媒介效果",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "comparative-literature",
    "names": {
      "zh-CN": "比较文学：跨文化/跨媒介/翻译/世界文学",
      "en": "comparative-literature"
    },
    "aliases": [],
    "parents": [
      "literature"
    ],
    "level": "sub-discipline",
    "description": "比较文学：跨文化/跨媒介/翻译/世界文学",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "comparative-politics",
    "names": {
      "zh-CN": "比较政治学：政体/制度/民主化/国家能力",
      "en": "comparative-politics"
    },
    "aliases": [],
    "parents": [
      "political-science"
    ],
    "level": "sub-discipline",
    "description": "比较政治学：政体/制度/民主化/国家能力",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "comparative-religion",
    "names": {
      "zh-CN": "比较宗教学：宗教现象/仪式/神秘主义/对话",
      "en": "comparative-religion"
    },
    "aliases": [],
    "parents": [
      "religious-studies"
    ],
    "level": "sub-discipline",
    "description": "比较宗教学：宗教现象/仪式/神秘主义/对话",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "complex-systems",
    "names": {
      "zh-CN": "复杂系统：涌现/网络科学/非线性动力学",
      "en": "complex-systems"
    },
    "aliases": [],
    "parents": [
      "systems-science"
    ],
    "level": "sub-discipline",
    "description": "复杂系统：涌现/网络科学/非线性动力学",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "computational-logic",
    "names": {
      "zh-CN": "计算逻辑：自动推理/逻辑编程/SAT求解",
      "en": "computational-logic"
    },
    "aliases": [],
    "parents": [
      "logic"
    ],
    "level": "sub-discipline",
    "description": "计算逻辑：自动推理/逻辑编程/SAT求解",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "computer-architecture",
    "names": {
      "zh-CN": "计算机体系结构：处理器/内存/并行架构",
      "en": "computer-architecture"
    },
    "aliases": [],
    "parents": [
      "computer-science"
    ],
    "level": "sub-discipline",
    "description": "计算机体系结构：处理器/内存/并行架构",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "computer-graphics",
    "names": {
      "zh-CN": "计算机图形学：渲染/几何处理/动画",
      "en": "computer-graphics"
    },
    "aliases": [],
    "parents": [
      "computer-science"
    ],
    "level": "sub-discipline",
    "description": "计算机图形学：渲染/几何处理/动画",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "computer-science",
    "names": {
      "zh-CN": "计算机科学",
      "en": "computer-science"
    },
    "aliases": [],
    "parents": [
      "formal-science"
    ],
    "level": "discipline",
    "description": "计算机科学——计算与信息的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "condensed-matter",
    "names": {
      "zh-CN": "凝聚态物理：固体/超导/半导体/纳米",
      "en": "condensed-matter"
    },
    "aliases": [],
    "parents": [
      "physics"
    ],
    "level": "sub-discipline",
    "description": "凝聚态物理：固体/超导/半导体/纳米",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "control-theory",
    "names": {
      "zh-CN": "控制论：反馈/稳定性/最优控制/自适应",
      "en": "control-theory"
    },
    "aliases": [],
    "parents": [
      "systems-science"
    ],
    "level": "sub-discipline",
    "description": "控制论：反馈/稳定性/最优控制/自适应",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "cosmology",
    "names": {
      "zh-CN": "宇宙学：大爆炸/暗物质/暗能量/膨胀",
      "en": "cosmology"
    },
    "aliases": [],
    "parents": [
      "space-science"
    ],
    "level": "sub-discipline",
    "description": "宇宙学：大爆炸/暗物质/暗能量/膨胀",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "creative-writing",
    "names": {
      "zh-CN": "创意写作：小说/诗歌/非虚构/剧本",
      "en": "creative-writing"
    },
    "aliases": [],
    "parents": [
      "literature"
    ],
    "level": "sub-discipline",
    "description": "创意写作：小说/诗歌/非虚构/剧本",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "criminology",
    "names": {
      "zh-CN": "犯罪学：犯罪原因/刑罚/预防/被害人",
      "en": "criminology"
    },
    "aliases": [],
    "parents": [
      "sociology"
    ],
    "level": "sub-discipline",
    "description": "犯罪学：犯罪原因/刑罚/预防/被害人",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "cryptography",
    "names": {
      "zh-CN": "密码学：加密/签名/零知识/安全多方",
      "en": "cryptography"
    },
    "aliases": [],
    "parents": [
      "computer-science"
    ],
    "level": "sub-discipline",
    "description": "密码学：加密/签名/零知识/安全多方",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "cultural-anthropology",
    "names": {
      "zh-CN": "文化人类学：仪式/亲属/符号/文化变迁",
      "en": "cultural-anthropology"
    },
    "aliases": [],
    "parents": [
      "anthropology"
    ],
    "level": "sub-discipline",
    "description": "文化人类学：仪式/亲属/符号/文化变迁",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "curriculum-design",
    "names": {
      "zh-CN": "课程设计：教学设计/评估/标准/教材",
      "en": "curriculum-design"
    },
    "aliases": [],
    "parents": [
      "education"
    ],
    "level": "sub-discipline",
    "description": "课程设计：教学设计/评估/标准/教材",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "databases",
    "names": {
      "zh-CN": "数据库系统：关系模型/查询优化/事务",
      "en": "databases"
    },
    "aliases": [],
    "parents": [
      "computer-science"
    ],
    "level": "sub-discipline",
    "description": "数据库系统：关系模型/查询优化/事务",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "demography",
    "names": {
      "zh-CN": "人口学：生育/死亡/迁移/人口结构",
      "en": "demography"
    },
    "aliases": [],
    "parents": [
      "sociology"
    ],
    "level": "sub-discipline",
    "description": "人口学：生育/死亡/迁移/人口结构",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "development-economics",
    "names": {
      "zh-CN": "发展经济学：贫困/增长/制度/人力资本",
      "en": "development-economics"
    },
    "aliases": [],
    "parents": [
      "economics"
    ],
    "level": "sub-discipline",
    "description": "发展经济学：贫困/增长/制度/人力资本",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "developmental-psychology",
    "names": {
      "zh-CN": "发展心理学：儿童/青少年/老年/毕生发展",
      "en": "developmental-psychology"
    },
    "aliases": [],
    "parents": [
      "psychology"
    ],
    "level": "sub-discipline",
    "description": "发展心理学：儿童/青少年/老年/毕生发展",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "earth-science",
    "names": {
      "zh-CN": "地球科学",
      "en": "earth-science"
    },
    "aliases": [],
    "parents": [
      "natural-science"
    ],
    "level": "discipline",
    "description": "地球科学——地球系统的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "east-asian-studies",
    "names": {
      "zh-CN": "东亚研究：中日韩/儒家文化圈/东亚现代性",
      "en": "east-asian-studies"
    },
    "aliases": [],
    "parents": [
      "area-studies"
    ],
    "level": "sub-discipline",
    "description": "东亚研究：中日韩/儒家文化圈/东亚现代性",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "ecology",
    "names": {
      "zh-CN": "生态学：种群/群落/生态系统/生物多样性",
      "en": "ecology"
    },
    "aliases": [],
    "parents": [
      "biology"
    ],
    "level": "sub-discipline",
    "description": "生态学：种群/群落/生态系统/生物多样性",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "econometrics",
    "names": {
      "zh-CN": "计量经济学：回归/时间序列/面板/因果推断",
      "en": "econometrics"
    },
    "aliases": [],
    "parents": [
      "economics"
    ],
    "level": "sub-discipline",
    "description": "计量经济学：回归/时间序列/面板/因果推断",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "economics",
    "names": {
      "zh-CN": "经济学",
      "en": "economics"
    },
    "aliases": [],
    "parents": [
      "social-science"
    ],
    "level": "discipline",
    "description": "经济学——资源配置的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "education",
    "names": {
      "zh-CN": "教育学",
      "en": "education"
    },
    "aliases": [],
    "parents": [
      "applied-science"
    ],
    "level": "discipline",
    "description": "教育学——学习与教学的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "educational-technology",
    "names": {
      "zh-CN": "教育技术：在线学习/学习分析/EdTech",
      "en": "educational-technology"
    },
    "aliases": [],
    "parents": [
      "education"
    ],
    "level": "sub-discipline",
    "description": "教育技术：在线学习/学习分析/EdTech",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "educational-theory",
    "names": {
      "zh-CN": "教育理论：学习理论/课程论/教育哲学",
      "en": "educational-theory"
    },
    "aliases": [],
    "parents": [
      "education"
    ],
    "level": "sub-discipline",
    "description": "教育理论：学习理论/课程论/教育哲学",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "electrical-engineering",
    "names": {
      "zh-CN": "电气工程：电路/电力/控制/信号处理",
      "en": "electrical-engineering"
    },
    "aliases": [],
    "parents": [
      "engineering"
    ],
    "level": "sub-discipline",
    "description": "电气工程：电路/电力/控制/信号处理",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "electromagnetism",
    "names": {
      "zh-CN": "电磁学：电场/磁场/麦克斯韦方程/光学",
      "en": "electromagnetism"
    },
    "aliases": [],
    "parents": [
      "physics"
    ],
    "level": "sub-discipline",
    "description": "电磁学：电场/磁场/麦克斯韦方程/光学",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "engineering",
    "names": {
      "zh-CN": "工程学",
      "en": "engineering"
    },
    "aliases": [],
    "parents": [
      "applied-science"
    ],
    "level": "discipline",
    "description": "工程学——建造与实现的学科根",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "environmental-engineering",
    "names": {
      "zh-CN": "环境工程：水处理/大气/固废/修复",
      "en": "environmental-engineering"
    },
    "aliases": [],
    "parents": [
      "engineering"
    ],
    "level": "sub-discipline",
    "description": "环境工程：水处理/大气/固废/修复",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "environmental-science",
    "names": {
      "zh-CN": "环境科学：污染/生态修复/可持续发展",
      "en": "environmental-science"
    },
    "aliases": [],
    "parents": [
      "earth-science"
    ],
    "level": "sub-discipline",
    "description": "环境科学：污染/生态修复/可持续发展",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "epistemology",
    "names": {
      "zh-CN": "认识论：知识/信念/证成/怀疑论",
      "en": "epistemology"
    },
    "aliases": [],
    "parents": [
      "philosophy"
    ],
    "level": "sub-discipline",
    "description": "认识论：知识/信念/证成/怀疑论",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "ethics",
    "names": {
      "zh-CN": "伦理学：规范伦理/元伦理/应用伦理/美德",
      "en": "ethics"
    },
    "aliases": [],
    "parents": [
      "philosophy"
    ],
    "level": "sub-discipline",
    "description": "伦理学：规范伦理/元伦理/应用伦理/美德",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "european-studies",
    "names": {
      "zh-CN": "欧洲研究：欧盟/欧洲一体化/欧洲史/欧洲文化",
      "en": "european-studies"
    },
    "aliases": [],
    "parents": [
      "area-studies"
    ],
    "level": "sub-discipline",
    "description": "欧洲研究：欧盟/欧洲一体化/欧洲史/欧洲文化",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "evolutionary-biology",
    "names": {
      "zh-CN": "进化生物学：自然选择/物种形成/系统发生",
      "en": "evolutionary-biology"
    },
    "aliases": [],
    "parents": [
      "biology"
    ],
    "level": "sub-discipline",
    "description": "进化生物学：自然选择/物种形成/系统发生",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "film-studies",
    "names": {
      "zh-CN": "电影研究：电影史/理论/批评/产业",
      "en": "film-studies"
    },
    "aliases": [],
    "parents": [
      "arts"
    ],
    "level": "sub-discipline",
    "description": "电影研究：电影史/理论/批评/产业",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "finance",
    "names": {
      "zh-CN": "金融学：资产定价/公司金融/风险管理/投资",
      "en": "finance"
    },
    "aliases": [],
    "parents": [
      "economics"
    ],
    "level": "sub-discipline",
    "description": "金融学：资产定价/公司金融/风险管理/投资",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "fishery",
    "names": {
      "zh-CN": "水产学：养殖/捕捞/资源/水产加工",
      "en": "fishery"
    },
    "aliases": [],
    "parents": [
      "agriculture"
    ],
    "level": "sub-discipline",
    "description": "水产学：养殖/捕捞/资源/水产加工",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "forestry",
    "names": {
      "zh-CN": "林学：森林经营/造林/森林生态/木材",
      "en": "forestry"
    },
    "aliases": [],
    "parents": [
      "agriculture"
    ],
    "level": "sub-discipline",
    "description": "林学：森林经营/造林/森林生态/木材",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "formal-science",
    "names": {
      "zh-CN": "形式科学门类",
      "en": "formal-science"
    },
    "aliases": [],
    "parents": [],
    "level": "category",
    "description": "形式科学门类——数学/逻辑/CS/统计/系统科学的中层",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
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
  },
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
