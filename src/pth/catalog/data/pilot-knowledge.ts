/**
 * catalog/data/pilot-knowledge.ts — N23 K5 评测批：双域 domain-fact 知识条目。
 *
 * 每个域 12 条（共 24）。核心条目（core）额外锚定 domain 的祖先链，
 * 使 K3 relevance（anchors ∩ (domains ∪ ancestors(domains))）能将其排到 top-5；
 * 非核心条目仅锚定 domain id + 概念锚点。所有条目 content ≤300 字符，
 * evidence.sourceId 均存在于 PILOT_SOURCES。
 */

export interface PilotKnowledgeEntry {
  id: string; // 全局唯一
  domain: string;
  kind: "domain-fact";
  anchors: string[]; // 含 domain id + 概念锚点
  content: string; // 一句话权威定义/判据（≤300 字符）
  evidence: Array<{ sourceId: string; locator: string }>; // sourceId 必须存在 PILOT_SOURCES
}

function entry(args: {
  id: string;
  domain: "programming-languages" | "materials-science";
  anchors: string[];
  content: string;
  evidence: Array<{ sourceId: string; locator: string }>;
}): PilotKnowledgeEntry {
  return { ...args, kind: "domain-fact" };
}

/** programming-languages 祖先链：computer-science → formal-science。 */
const PL_CHAIN = ["programming-languages", "computer-science", "formal-science"] as const;
/** materials-science 祖先链：engineering → applied-science。 */
const MS_CHAIN = ["materials-science", "engineering", "applied-science"] as const;

export const PILOT_KNOWLEDGE: PilotKnowledgeEntry[] = [
  // ── programming-languages（12 条；前 5 条为 core：完整祖先链 + 概念锚点）──
  entry({
    id: "pl-fact-type-checking",
    domain: "programming-languages",
    anchors: [...PL_CHAIN, "类型检查", "type checking", "静态类型"],
    content:
      "类型检查是在编译期依据语言类型规则核对程序中的名字与表达式、拒绝违反类型规则的代码；Java、Rust 等静态类型语言借此在运行前排除一类类型错误。",
    evidence: [
      { sourceId: "pl-jls", locator: "JLS SE23 §4.12.2: compile-time checking of variables" },
      { sourceId: "pl-rust-reference", locator: "Rust Reference: type system / compile-time checks" },
    ],
  }),
  entry({
    id: "pl-fact-ir",
    domain: "programming-languages",
    anchors: [...PL_CHAIN, "中间表示", "intermediate representation", "LLVM IR"],
    content:
      "中间表示是编译器中连接前端与后端的程序表示，如 LLVM IR、Java 字节码与 Rust MIR；它保留语义信息同时屏蔽语言与目标机器差异，便于分析与优化。",
    evidence: [
      { sourceId: "pl-llvm-langref", locator: "LLVM LangRef: Abstract, IR structure" },
      { sourceId: "pl-rust-reference", locator: "Rust Reference: MIR description" },
    ],
  }),
  entry({
    id: "pl-fact-codegen",
    domain: "programming-languages",
    anchors: [...PL_CHAIN, "代码生成", "code generation", "指令选择"],
    content:
      "代码生成是编译器后端把中间表示翻译为目标机器码或字节码的步骤，通常包含指令选择、寄存器分配与指令调度等阶段。",
    evidence: [
      { sourceId: "pl-llvm-langref", locator: "LLVM LangRef: code generation conventions" },
    ],
  }),
  entry({
    id: "pl-fact-abi",
    domain: "programming-languages",
    anchors: [...PL_CHAIN, "ABI", "二进制接口", "调用约定"],
    content:
      "ABI 定义二进制接口约定，规定参数与返回值如何经寄存器/栈传递、类型如何布局、符号如何修饰，使不同编译单元或语言编译产物可以互操作。",
    evidence: [
      { sourceId: "pl-cpp-draft", locator: "C++ draft [defns.abi]: application binary interface" },
      { sourceId: "pl-rust-reference", locator: "Rust Reference: external ABI declarations" },
    ],
  }),
  entry({
    id: "pl-fact-memory-model",
    domain: "programming-languages",
    anchors: [...PL_CHAIN, "内存模型", "memory model", "happens-before"],
    content:
      "内存模型规定多线程程序读写共享内存的可见性与顺序约束；C++ 内存模型以 happens-before 与原子操作界定数据竞争的边界。",
    evidence: [
      { sourceId: "pl-cpp-draft", locator: "C++ draft [intro.memory], [intro.races]" },
    ],
  }),
  entry({
    id: "pl-fact-type-system",
    domain: "programming-languages",
    anchors: ["programming-languages", "类型系统", "type system", "类型规则"],
    content:
      "类型系统是编程语言为表达式与值指派类型并规定类型规则的形式体系，用于约束程序行为、支撑类型检查与类型推导。",
    evidence: [
      { sourceId: "pl-jls", locator: "JLS SE23 Chapter 4: Types, Values, and Variables" },
      { sourceId: "pl-rust-reference", locator: "Rust Reference: type system" },
    ],
  }),
  entry({
    id: "pl-fact-language-specification",
    domain: "programming-languages",
    anchors: ["programming-languages", "语言规范", "language specification", "标准"],
    content:
      "语言规范是编程语言语法与语义的权威定义文档，是编译器实现、类型检查与程序行为判定的最终依据。",
    evidence: [
      { sourceId: "pl-jls", locator: "JLS SE23: The Java Language Specification" },
      { sourceId: "pl-ecma262", locator: "ECMA-262: ECMAScript Language Specification" },
    ],
  }),
  entry({
    id: "pl-fact-semantics",
    domain: "programming-languages",
    anchors: ["programming-languages", "语义", "semantics", "求值"],
    content:
      "程序语言的语义描述程序执行的含义，包括静态语义（编译期约束）与动态语义（运行时行为），是语言规范的核心内容。",
    evidence: [
      { sourceId: "pl-ecma262", locator: "ECMA-262: static and runtime semantics clauses" },
    ],
  }),
  entry({
    id: "pl-fact-standard-library",
    domain: "programming-languages",
    anchors: ["programming-languages", "标准库", "standard library"],
    content:
      "标准库是编程语言随实现提供的一组权威库，覆盖基础数据结构、I/O 与平台接口；其行为由语言规范或官方文档定义。",
    evidence: [
      { sourceId: "pl-python-reference", locator: "Python Language Reference: standard library relationship" },
    ],
  }),
  entry({
    id: "pl-fact-program-analysis",
    domain: "programming-languages",
    anchors: ["programming-languages", "程序分析", "program analysis", "静态分析"],
    content:
      "程序分析是对程序源码或中间表示进行自动推理以获取性质（如类型、别名、流敏感信息）的技术，静态分析通常在编译期执行。",
    evidence: [
      { sourceId: "pl-llvm-langref", locator: "LLVM LangRef: IR as analysis input" },
    ],
  }),
  entry({
    id: "pl-fact-compiler",
    domain: "programming-languages",
    anchors: ["programming-languages", "编译器", "compiler", "编译"],
    content:
      "编译器把一种编程语言写成的源码翻译为另一种语言（通常为目标机器码或字节码），典型结构包括前端、优化与后端。",
    evidence: [
      { sourceId: "pl-llvm-langref", locator: "LLVM LangRef: compiler IR pipeline" },
    ],
  }),
  entry({
    id: "pl-fact-ast",
    domain: "programming-languages",
    anchors: ["programming-languages", "抽象语法树", "AST", "语法树"],
    content:
      "抽象语法树是源码的结构化表示，记录语法结构并丢弃表面语法细节；编译器前端用它完成名字解析与类型检查。",
    evidence: [
      { sourceId: "pl-python-reference", locator: "Python Reference: AST / compilation phases" },
    ],
  }),

  // ── materials-science（12 条；前 5 条为 core：完整祖先链 + 概念锚点）──
  entry({
    id: "ms-fact-ionic-conductivity",
    domain: "materials-science",
    anchors: [...MS_CHAIN, "离子电导率", "ionic conductivity", "固态电解质"],
    content:
      "固态电解质的离子电导率描述离子在固相中迁移的能力，实用判据常要求室温总电导率 ≥10⁻³ S/cm，且电子电导占比足够低。",
    evidence: [
      { sourceId: "ms-materials-project", locator: "Materials Project: ionic conductivity data fields" },
      { sourceId: "ms-nomad", locator: "NOMAD: ionic conductivity datasets" },
    ],
  }),
  entry({
    id: "ms-fact-activation-energy",
    domain: "materials-science",
    anchors: [...MS_CHAIN, "活化能", "activation energy", "Arrhenius"],
    content:
      "离子迁移活化能 Ea 衡量离子跃迁所需克服的能垒，Arrhenius 关系 σT=σ₀·exp(-Ea/kBT) 描述其温度依赖；固态电解质研究通常追求 Ea<0.4 eV。",
    evidence: [
      { sourceId: "ms-nomad", locator: "NOMAD: activation energy metadata" },
      { sourceId: "ms-aflow", locator: "AFLOW: migration barrier data" },
    ],
  }),
  entry({
    id: "ms-fact-electrochemical-window",
    domain: "materials-science",
    anchors: [...MS_CHAIN, "电化学稳定窗口", "electrochemical stability window", "氧化还原电位"],
    content:
      "电化学稳定窗口指电解质对电极保持惰性的电压区间，由 HOMO/LUMO 或热力学氧化/还原电位界定；窗口越宽越能匹配高压正极与金属负极。",
    evidence: [
      { sourceId: "ms-materials-project", locator: "Materials Project: stability window from phase diagrams" },
    ],
  }),
  entry({
    id: "ms-fact-interface-stability",
    domain: "materials-science",
    anchors: [...MS_CHAIN, "界面稳定性", "interface stability", "SEI"],
    content:
      "界面稳定性描述固态电解质与电极之间是否生成稳定界面相；稳定的 SEI/界面层应电子绝缘、离子导通，并抑制持续副反应。",
    evidence: [
      { sourceId: "ms-materials-project", locator: "Materials Project: interface reaction data" },
      { sourceId: "ms-nomad", locator: "NOMAD: interface stability datasets" },
    ],
  }),
  entry({
    id: "ms-fact-crystal-structure",
    domain: "materials-science",
    anchors: [...MS_CHAIN, "晶体结构", "crystal structure", "扩散通道"],
    content:
      "晶体结构决定离子扩散通道与配位环境；固态电解质中石榴石型等骨架提供锂/钠离子连续迁移路径，是离子电导率的材料基础。",
    evidence: [
      { sourceId: "ms-icsd", locator: "ICSD: crystal structure records" },
      { sourceId: "ms-aflow", locator: "AFLOW: prototype crystal structures" },
    ],
  }),
  entry({
    id: "ms-fact-band-gap",
    domain: "materials-science",
    anchors: ["materials-science", "带隙", "band gap", "电子结构"],
    content:
      "带隙是材料电子结构中价带顶与导带底之间的能量差，决定电子导电性；固态电解质通常要求宽带隙以保持电子绝缘。",
    evidence: [
      { sourceId: "ms-materials-project", locator: "Materials Project: band gap data" },
    ],
  }),
  entry({
    id: "ms-fact-thermal-stability",
    domain: "materials-science",
    anchors: ["materials-science", "热稳定性", "thermal stability", "分解温度"],
    content:
      "热稳定性描述材料在升温或循环产热下保持结构与组成不变的能力，固态电解质需要足够的热稳定窗口以匹配电池工作温度。",
    evidence: [
      { sourceId: "ms-nomad", locator: "NOMAD: thermal stability calculations" },
    ],
  }),
  entry({
    id: "ms-fact-mechanical-properties",
    domain: "materials-science",
    anchors: ["materials-science", "机械性能", "mechanical properties", "弹性模量"],
    content:
      "机械性能包括弹性模量、硬度与断裂韧性，决定固态电解质在电极体积变化下是否开裂并保持界面接触。",
    evidence: [
      { sourceId: "ms-aflow", locator: "AFLOW: elastic property data" },
    ],
  }),
  entry({
    id: "ms-fact-transference-number",
    domain: "materials-science",
    anchors: ["materials-science", "离子迁移数", "transference number"],
    content:
      "离子迁移数指目标离子承担的电流占总电流的比例；固态电解质追求锂/钠离子迁移数接近 1，以降低浓差极化。",
    evidence: [
      { sourceId: "ms-nomad", locator: "NOMAD: transport property datasets" },
    ],
  }),
  entry({
    id: "ms-fact-diffusion-coefficient",
    domain: "materials-science",
    anchors: ["materials-science", "扩散系数", "diffusion coefficient"],
    content:
      "扩散系数描述离子在材料中的迁移快慢，与离子电导率经 Nernst-Einstein 关系关联，是评估固态电解质输运性能的重要参数。",
    evidence: [
      { sourceId: "ms-materials-project", locator: "Materials Project: diffusivity data" },
    ],
  }),
  entry({
    id: "ms-fact-phase-stability",
    domain: "materials-science",
    anchors: ["materials-science", "相稳定性", "phase stability", "相图"],
    content:
      "相稳定性描述材料在给定组分与温度下保持单相或目标相的能力，可用相图与形成能判断；固态电解质需在工作条件下保持稳定相。",
    evidence: [
      { sourceId: "ms-materials-project", locator: "Materials Project: phase diagrams" },
    ],
  }),
  entry({
    id: "ms-fact-electrochemical-impedance",
    domain: "materials-science",
    anchors: ["materials-science", "电化学阻抗谱", "EIS", "阻抗"],
    content:
      "电化学阻抗谱通过交流阻抗测量解析固态电解质的体相、晶界与界面贡献，是离子电导率与界面稳定性评价的常用实验方法。",
    evidence: [
      { sourceId: "ms-nomad", locator: "NOMAD: EIS datasets" },
    ],
  }),
];
