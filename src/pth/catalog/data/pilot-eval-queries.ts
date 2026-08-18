/**
 * catalog/data/pilot-eval-queries.ts — N23 K5 + F4 + R5 冻结查询集。
 *
 * R5/P1-3 扩展：
 *  - 标准题覆盖全部 24 条 domain-fact（每条至少 1 direct + 1 compositional）；
 *  - 新题型：no-answer-same-domain / irrelevant / order-perturbation / conflict /
 *    version（old/latest/changed）/ tenant-space；
 *  - holdout ≥30%：冻结 digest 与 seed/alias 生成隔离，不参与调参。
 */

export type PilotEvalQueryType =
  | "standard"
  | "hard-negative"
  | "no-answer-same-domain"
  | "irrelevant"
  | "order-perturbation"
  | "conflict"
  | "version"
  | "tenant-space"
  | "multi-domain"
  | "distractor";

export interface PilotEvalQuery {
  id: string; // 全局唯一
  domain: string; // 期望 domain（题型归属）
  text: string; // 冻结查询（中文）
  authoritative: boolean; // 是否需要权威事实/证据（§12.3）
  expectedEntryIds: string[]; // 期望 top-5 命中的 knowledge entry（标准题 ≥1；硬负例/多域/混淆可为 []）
  /** hard negative / no-answer：正确行为 = top5 为空 */
  expectNoKnowledge?: boolean;
  /** 多 Domain 组合：resolver 前 3 必须包含全部 expectedDomains */
  expectedDomains?: string[];
  /** 混淆题：近义 domain 干扰；期望 primaryDomain=目标域或目标域在 top3 */
  distractorDomain?: string;
  /** R5 题型；缺省按字段推断 */
  type?: PilotEvalQueryType;
  /** tenant/space visibility：评测用租户/空间覆盖 */
  tenantId?: string;
  space?: string;
  /** irrelevant：这些 entryId 不得进入 top5 */
  irrelevantEntryIds?: string[];
  /** conflict：这些 sourceId（短 id 或 pilot-source:<id>）必须全部出现在 top5 evidence */
  conflictSourceIds?: string[];
  /** version：old / latest / changed */
  versionExpectation?: "old" | "latest" | "changed";
  /** version：期望 evidence 中出现的 sourceId+sourceVersion */
  expectedSourceVersions?: Array<{ sourceId: string; sourceVersion?: string }>;
  /** holdout 冻结子集 */
  holdout?: boolean;
}

function q(
  id: string,
  domain: string,
  text: string,
  opts: Partial<PilotEvalQuery> = {},
): PilotEvalQuery {
  return {
    id,
    domain,
    text,
    authoritative: opts.authoritative ?? true,
    expectedEntryIds: opts.expectedEntryIds ?? [],
    ...opts,
  };
}

export const PILOT_EVAL_QUERIES: PilotEvalQuery[] = [
  // ════════════════════════════════════════════════════════════════════
  // programming-languages（30 条标准题，core 5 条 ×6）
  // ════════════════════════════════════════════════════════════════════
  q("pl-01", "programming-languages", "Java 编程语言中，类型检查发生在编译期还是运行期？", { expectedEntryIds: ["pl-fact-type-checking"] }),
  q("pl-02", "programming-languages", "Rust 编程语言的类型检查如何帮助在运行前排除内存安全问题？", { expectedEntryIds: ["pl-fact-type-checking"] }),
  q("pl-03", "programming-languages", "C++ 编译器的类型检查为什么允许某些隐式转换？", { expectedEntryIds: ["pl-fact-type-checking"] }),
  q("pl-04", "programming-languages", "Python 编程语言是动态类型还是静态类型？其类型检查在何时执行？", { expectedEntryIds: ["pl-fact-type-checking"] }),
  q("pl-05", "programming-languages", "编程语言中的类型检查与类型推导有什么区别？", { expectedEntryIds: ["pl-fact-type-checking"] }),
  q("pl-06", "programming-languages", "什么是编程语言的类型检查器？它会拒绝哪一类程序？", { expectedEntryIds: ["pl-fact-type-checking"] }),
  q("pl-07", "programming-languages", "LLVM 中间表示在编译器后端中起什么作用？", { expectedEntryIds: ["pl-fact-ir"] }),
  q("pl-08", "programming-languages", "Java 编程语言的字节码属于哪一种中间表示？", { expectedEntryIds: ["pl-fact-ir"] }),
  q("pl-09", "programming-languages", "Rust 编译器的 MIR 中间表示主要用于哪些分析？", { expectedEntryIds: ["pl-fact-ir"] }),
  q("pl-10", "programming-languages", "编译器为什么要把源码先转成中间表示而不是直接生成目标代码？", { expectedEntryIds: ["pl-fact-ir"] }),
  q("pl-11", "programming-languages", "Clang 这类编译器生成 LLVM 中间表示之后还会做哪些处理？", { expectedEntryIds: ["pl-fact-ir"] }),
  q("pl-12", "programming-languages", "中间表示需要保留程序语言的哪些语义信息？", { expectedEntryIds: ["pl-fact-ir"] }),
  q("pl-13", "programming-languages", "编译器把中间表示翻译为目标机器码时，指令选择做什么？", { expectedEntryIds: ["pl-fact-codegen"] }),
  q("pl-14", "programming-languages", "LLVM 编译器在代码生成阶段如何处理寄存器分配？", { expectedEntryIds: ["pl-fact-codegen"] }),
  q("pl-15", "programming-languages", "编程语言的编译器后端进行代码生成通常包括哪些阶段？", { expectedEntryIds: ["pl-fact-codegen"] }),
  q("pl-16", "programming-languages", "JIT 编译器在运行时进行代码生成，与静态编译的代码生成有什么不同？", { expectedEntryIds: ["pl-fact-codegen"] }),
  q("pl-17", "programming-languages", "Rust 编译器的代码生成直接输出目标代码还是先经过汇编器？", { expectedEntryIds: ["pl-fact-codegen"] }),
  q("pl-18", "programming-languages", "编译器进行代码生成时如何利用 ABI 决定参数传递方式？", { expectedEntryIds: ["pl-fact-abi"] }),
  q("pl-19", "programming-languages", "C 语言 ABI 在编译器层面规定函数参数如何传递？", { expectedEntryIds: ["pl-fact-abi"] }),
  q("pl-20", "programming-languages", "Rust 编程语言默认使用哪种 ABI？如何声明 C ABI 接口？", { expectedEntryIds: ["pl-fact-abi"] }),
  q("pl-21", "programming-languages", "编译器生成的符号名为什么要遵循 ABI 的名称修饰约定？", { expectedEntryIds: ["pl-fact-abi"] }),
  q("pl-22", "programming-languages", "不同 C++ 编译器编译出的库能互相链接吗？ABI 兼容性如何判断？", { expectedEntryIds: ["pl-fact-abi"] }),
  q("pl-23", "programming-languages", "ABI 与 API 在编程语言和编译器层面有什么区别？", { expectedEntryIds: ["pl-fact-abi"] }),
  q("pl-24", "programming-languages", "JVM 字节码调用约定是否属于编程语言 ABI 的范畴？", { expectedEntryIds: ["pl-fact-abi"] }),
  q("pl-25", "programming-languages", "C++ 编程语言的内存模型如何定义数据竞争？", { expectedEntryIds: ["pl-fact-memory-model"] }),
  q("pl-26", "programming-languages", "Java 编程语言内存模型中的 happens-before 关系有什么作用？", { expectedEntryIds: ["pl-fact-memory-model"] }),
  q("pl-27", "programming-languages", "Rust 编程语言的所有权模型与底层内存模型是什么关系？", { expectedEntryIds: ["pl-fact-memory-model"] }),
  q("pl-28", "programming-languages", "编程语言内存模型为什么需要区分顺序一致性与弱内存序？", { expectedEntryIds: ["pl-fact-memory-model"] }),
  q("pl-29", "programming-languages", "C++11 编程语言引入内存模型后，volatile 还能用于线程同步吗？", { expectedEntryIds: ["pl-fact-memory-model"] }),
  q("pl-30", "programming-languages", "编译器与 CPU 的指令重排在编程语言内存模型中如何被约束？", { expectedEntryIds: ["pl-fact-memory-model"] }),

  // ════════════════════════════════════════════════════════════════════
  // materials-science（30 条标准题，core 5 条 ×6）
  // ════════════════════════════════════════════════════════════════════
  q("ms-01", "materials-science", "固态电解质的离子电导率达到多少才适合用于全固态电池？", { expectedEntryIds: ["ms-fact-ionic-conductivity"] }),
  q("ms-02", "materials-science", "材料数据库 Materials Project 如何标注固态电解质的离子电导率？", { expectedEntryIds: ["ms-fact-ionic-conductivity"] }),
  q("ms-03", "materials-science", "提高固态电解质离子电导率的主要材料设计策略有哪些？", { expectedEntryIds: ["ms-fact-ionic-conductivity"] }),
  q("ms-04", "materials-science", "固态电解质的电子电导与离子电导率比值为什么必须足够低？", { expectedEntryIds: ["ms-fact-ionic-conductivity"] }),
  q("ms-05", "materials-science", "NOMAD 数据库中的离子电导率数据如何用于固态电解质筛选？", { expectedEntryIds: ["ms-fact-ionic-conductivity"] }),
  q("ms-06", "materials-science", "材料科学中常用的离子电导率单位是什么？", { expectedEntryIds: ["ms-fact-ionic-conductivity"] }),
  q("ms-07", "materials-science", "固态电解质的离子迁移活化能 Ea 低于多少 eV 才被认为适合应用？", { expectedEntryIds: ["ms-fact-activation-energy"] }),
  q("ms-08", "materials-science", "Arrhenius 关系如何描述固态电解质离子电导率随温度的变化？", { expectedEntryIds: ["ms-fact-activation-energy"] }),
  q("ms-09", "materials-science", "固态电解质的活化能通常用哪种实验方法测量？", { expectedEntryIds: ["ms-fact-activation-energy"] }),
  q("ms-10", "materials-science", "NOMAD 数据中的活化能字段对固态电解质筛选有什么价值？", { expectedEntryIds: ["ms-fact-activation-energy"] }),
  q("ms-11", "materials-science", "活化能与离子电导率的温度依赖性在材料科学中如何关联？", { expectedEntryIds: ["ms-fact-activation-energy"] }),
  q("ms-12", "materials-science", "为什么固态电解质研究通常追求 Ea 小于 0.4 eV？", { expectedEntryIds: ["ms-fact-activation-energy"] }),
  q("ms-13", "materials-science", "固态电解质的电化学稳定窗口如何决定其可匹配的电极材料？", { expectedEntryIds: ["ms-fact-electrochemical-window"] }),
  q("ms-14", "materials-science", "如何用 Materials Project 数据估算固态电解质的稳定电压窗口？", { expectedEntryIds: ["ms-fact-electrochemical-window"] }),
  q("ms-15", "materials-science", "固态电解质的电化学稳定窗口较窄时，在高压正极下会发生什么？", { expectedEntryIds: ["ms-fact-electrochemical-window"] }),
  q("ms-16", "materials-science", "材料科学中，固态电解质的电化学稳定窗口由哪些能级或电位决定？", { expectedEntryIds: ["ms-fact-electrochemical-window"] }),
  q("ms-17", "materials-science", "NOMAD 是否提供固态电解质的电化学稳定窗口相关的计算数据？", { expectedEntryIds: ["ms-fact-electrochemical-window"] }),
  q("ms-18", "materials-science", "硫化物固态电解质的电化学稳定窗口为什么通常比较窄？", { expectedEntryIds: ["ms-fact-electrochemical-window"] }),
  q("ms-19", "materials-science", "固态电解质与锂金属负极的界面稳定性如何影响电池循环？", { expectedEntryIds: ["ms-fact-interface-stability"] }),
  q("ms-20", "materials-science", "材料数据库 Materials Project 能用于筛选对金属锂稳定的固态电解质吗？", { expectedEntryIds: ["ms-fact-interface-stability"] }),
  q("ms-21", "materials-science", "固态电解质与电极之间理想的 SEI 应具备哪些性质？", { expectedEntryIds: ["ms-fact-interface-stability"] }),
  q("ms-22", "materials-science", "NOMAD 数据如何支持固态电解质界面稳定性的研究？", { expectedEntryIds: ["ms-fact-interface-stability"] }),
  q("ms-23", "materials-science", "固态电解质的界面稳定性如何影响离子电导率？", { expectedEntryIds: ["ms-fact-interface-stability"] }),
  q("ms-24", "materials-science", "材料科学中如何评价固态电解质与高压正极的界面稳定性？", { expectedEntryIds: ["ms-fact-interface-stability"] }),
  q("ms-25", "materials-science", "石榴石型固态电解质的晶体结构为何有利于锂离子传导？", { expectedEntryIds: ["ms-fact-crystal-structure"] }),
  q("ms-26", "materials-science", "Materials Project 中的晶体结构信息如何辅助固态电解质设计？", { expectedEntryIds: ["ms-fact-crystal-structure"] }),
  q("ms-27", "materials-science", "固态电解质晶体结构中的扩散通道指什么？", { expectedEntryIds: ["ms-fact-crystal-structure"] }),
  q("ms-28", "materials-science", "ICSD 与 AFLOW 等材料数据库如何提供固态电解质的晶体结构数据？", { expectedEntryIds: ["ms-fact-crystal-structure"] }),
  q("ms-29", "materials-science", "材料科学中，晶体结构对离子电导率的决定作用体现在哪里？", { expectedEntryIds: ["ms-fact-crystal-structure"] }),
  q("ms-30", "materials-science", "NOMAD 与 Materials Project 的晶体结构数据可以互相补充吗？", { expectedEntryIds: ["ms-fact-crystal-structure"] }),

  // ════════════════════════════════════════════════════════════════════
  // 补齐剩余 14 条知识的覆盖（每条 1 direct + 1 compositional，holdout 冻结）
  // ════════════════════════════════════════════════════════════════════
  // programming-languages 剩余 7 条
  q("pl-31", "programming-languages", "编程语言的类型系统如何约束程序行为？", { expectedEntryIds: ["pl-fact-type-system"], holdout: true }),
  q("pl-32", "programming-languages", "类型系统与类型检查在编程语言中如何协作？", { expectedEntryIds: ["pl-fact-type-system"], holdout: true }),
  q("pl-33", "programming-languages", "编程语言的语言规范为什么是编译器的最终依据？", { expectedEntryIds: ["pl-fact-language-specification"], holdout: true }),
  q("pl-34", "programming-languages", "语言规范如何约束编程语言的类型检查规则？", { expectedEntryIds: ["pl-fact-language-specification"], holdout: true }),
  q("pl-35", "programming-languages", "编程语言的静态语义和动态语义分别描述什么？", { expectedEntryIds: ["pl-fact-semantics"], holdout: true }),
  q("pl-36", "programming-languages", "语言规范如何用语义定义编程语言程序的运行时行为？", { expectedEntryIds: ["pl-fact-semantics"], holdout: true }),
  q("pl-37", "programming-languages", "编程语言的标准库通常包含哪些基础能力？", { expectedEntryIds: ["pl-fact-standard-library"], holdout: true }),
  q("pl-38", "programming-languages", "标准库与语言规范在编程语言实现中是什么关系？", { expectedEntryIds: ["pl-fact-standard-library"], holdout: true }),
  q("pl-39", "programming-languages", "编程语言中程序分析常用的静态分析技术有哪些？", { expectedEntryIds: ["pl-fact-program-analysis"], holdout: true }),
  q("pl-40", "programming-languages", "程序分析如何利用编译器生成的中间表示？", { expectedEntryIds: ["pl-fact-program-analysis"], holdout: true }),
  q("pl-41", "programming-languages", "编程语言的编译器通常由哪些阶段组成？", { expectedEntryIds: ["pl-fact-compiler"], holdout: true }),
  q("pl-42", "programming-languages", "编译器与抽象语法树在程序分析中如何衔接？", { expectedEntryIds: ["pl-fact-compiler"], holdout: true }),
  q("pl-43", "programming-languages", "编程语言中抽象语法树如何表示源码结构？", { expectedEntryIds: ["pl-fact-ast"], holdout: true }),
  q("pl-44", "programming-languages", "抽象语法树与编译器前端的类型检查如何协作？", { expectedEntryIds: ["pl-fact-ast"], holdout: true }),

  // materials-science 剩余 7 条
  q("ms-31", "materials-science", "固态电解质的带隙为什么通常要求较宽？", { expectedEntryIds: ["ms-fact-band-gap"], holdout: true }),
  q("ms-32", "materials-science", "带隙与电子结构如何决定固态电解质的电子绝缘性？", { expectedEntryIds: ["ms-fact-band-gap"], holdout: true }),
  q("ms-33", "materials-science", "固态电解质的热稳定性如何影响电池工作温度窗口？", { expectedEntryIds: ["ms-fact-thermal-stability"], holdout: true }),
  q("ms-34", "materials-science", "分解温度与热稳定性如何约束固态电解质的应用场景？", { expectedEntryIds: ["ms-fact-thermal-stability"], holdout: true }),
  q("ms-35", "materials-science", "固态电解质的机械性能如何影响与电极的界面接触？", { expectedEntryIds: ["ms-fact-mechanical-properties"], holdout: true }),
  q("ms-36", "materials-science", "弹性模量与机械性能如何帮助固态电解质抵抗电极体积变化？", { expectedEntryIds: ["ms-fact-mechanical-properties"], holdout: true }),
  q("ms-37", "materials-science", "固态电解质的离子迁移数接近 1 为什么能降低浓差极化？", { expectedEntryIds: ["ms-fact-transference-number"], holdout: true }),
  q("ms-38", "materials-science", "离子迁移数与离子电导率如何共同评价固态电解质？", { expectedEntryIds: ["ms-fact-transference-number"], holdout: true }),
  q("ms-39", "materials-science", "固态电解质的扩散系数如何描述离子迁移快慢？", { expectedEntryIds: ["ms-fact-diffusion-coefficient"], holdout: true }),
  q("ms-40", "materials-science", "扩散系数与离子电导率通过什么关系关联？", { expectedEntryIds: ["ms-fact-diffusion-coefficient"], holdout: true }),
  q("ms-41", "materials-science", "固态电解质的相稳定性如何用相图判断？", { expectedEntryIds: ["ms-fact-phase-stability"], holdout: true }),
  q("ms-42", "materials-science", "相稳定性与晶体结构如何共同影响固态电解质性能？", { expectedEntryIds: ["ms-fact-phase-stability"], holdout: true }),
  q("ms-43", "materials-science", "电化学阻抗谱如何解析固态电解质的体相与界面贡献？", { expectedEntryIds: ["ms-fact-electrochemical-impedance"], holdout: true }),
  q("ms-44", "materials-science", "电化学阻抗谱与离子电导率评价固态电解质时如何互补？", { expectedEntryIds: ["ms-fact-electrochemical-impedance"], holdout: true }),

  // ════════════════════════════════════════════════════════════════════
  // hard negative / no-answer（resolver 无域 → top5 应为空）
  // ════════════════════════════════════════════════════════════════════
  q("pl-hn-01", "programming-languages", "no-answer-probe-pl-01 该词条未收录于任何知识体系", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true }),
  q("pl-hn-02", "programming-languages", "no-answer-probe-pl-02 没有任何条目覆盖这个随机主题", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true }),
  q("pl-hn-03", "programming-languages", "no-answer-probe-pl-03 今天晚饭吃什么", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true }),
  q("pl-hn-04", "programming-languages", "no-answer-probe-pl-04 这是一个无意义的占位问题", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true }),
  q("pl-hn-05", "programming-languages", "no-answer-probe-pl-05 无法找到对应的事实依据", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true }),
  q("pl-hn-06", "programming-languages", "no-answer-probe-pl-06 查询内容超出了试点范围", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true }),
  q("ms-hn-01", "materials-science", "no-answer-probe-ms-01 该词条没有任何已收录事实", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true }),
  q("ms-hn-02", "materials-science", "no-answer-probe-ms-02 这里问一个不存在于目录中的主题", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true }),
  q("ms-hn-03", "materials-science", "no-answer-probe-ms-03 明天会下雨吗", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true }),
  q("ms-hn-04", "materials-science", "no-answer-probe-ms-04 这是一个无意义的问题占位", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true }),
  q("ms-hn-05", "materials-science", "no-answer-probe-ms-05 找不到与该问题对应的事实", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true }),
  q("ms-hn-06", "materials-science", "no-answer-probe-ms-06 该查询超出试点知识范围", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true }),

  // ════════════════════════════════════════════════════════════════════
  // 同域 no-answer：resolver 已解析到域，但语料不支持（strict fail-closed → 空）
  // ════════════════════════════════════════════════════════════════════
  q("pl-na-01", "programming-languages", "编程语言领域如何评价量子烹饪的风味？", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true, type: "no-answer-same-domain" }),
  q("pl-na-02", "programming-languages", "编程语言中关于紫砂壶烧制的温度控制", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true, type: "no-answer-same-domain" }),
  q("ms-na-01", "materials-science", "材料科学领域如何评价量子烹饪的风味？", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true, type: "no-answer-same-domain" }),
  q("ms-na-02", "materials-science", "材料科学中关于紫砂壶烧制的温度控制", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true, type: "no-answer-same-domain" }),

  // ════════════════════════════════════════════════════════════════════
  // irrelevant：无关内容不得进入 top5
  // ════════════════════════════════════════════════════════════════════
  q("pl-ir-01", "programming-languages", "编程语言中的类型检查发生在编译期还是运行期？", { expectedEntryIds: ["pl-fact-type-checking"], type: "irrelevant", irrelevantEntryIds: ["pl-fact-ir", "pl-fact-codegen"] }),
  q("pl-ir-02", "programming-languages", "编译器后端进行代码生成通常包括哪些阶段？", { expectedEntryIds: ["pl-fact-codegen"], type: "irrelevant", irrelevantEntryIds: ["pl-fact-abi", "pl-fact-memory-model"] }),
  q("ms-ir-01", "materials-science", "固态电解质的离子电导率达到多少才适合用于全固态电池？", { expectedEntryIds: ["ms-fact-ionic-conductivity"], type: "irrelevant", irrelevantEntryIds: ["ms-fact-crystal-structure", "ms-fact-band-gap"] }),
  q("ms-ir-02", "materials-science", "固态电解质的活化能通常用哪种实验方法测量？", { expectedEntryIds: ["ms-fact-activation-energy"], type: "irrelevant", irrelevantEntryIds: ["ms-fact-thermal-stability", "ms-fact-mechanical-properties"] }),

  // ════════════════════════════════════════════════════════════════════
  // order-perturbation：输入顺序扰动不得改善指标（生产 rank 对输入顺序不敏感）
  // ════════════════════════════════════════════════════════════════════
  q("pl-op-01", "programming-languages", "Java 编程语言中，类型检查发生在编译期还是运行期？", { expectedEntryIds: ["pl-fact-type-checking"], type: "order-perturbation" }),
  q("pl-op-02", "programming-languages", "LLVM 中间表示在编译器后端中起什么作用？", { expectedEntryIds: ["pl-fact-ir"], type: "order-perturbation" }),
  q("ms-op-01", "materials-science", "固态电解质的离子电导率达到多少才适合用于全固态电池？", { expectedEntryIds: ["ms-fact-ionic-conductivity"], type: "order-perturbation" }),
  q("ms-op-02", "materials-science", "固态电解质的电化学稳定窗口如何决定其可匹配的电极材料？", { expectedEntryIds: ["ms-fact-electrochemical-window"], type: "order-perturbation" }),

  // ════════════════════════════════════════════════════════════════════
  // conflict：同一概念两个来源/版本冲突，必须可被检出（至少解析 authority/time 一方）
  // ════════════════════════════════════════════════════════════════════
  q("pl-cf-01", "programming-languages", "Oracle 与 Rust Project 对类型检查的描述是否一致？", { expectedEntryIds: ["pl-fact-type-checking"], type: "conflict", conflictSourceIds: ["pl-jls", "pl-rust-reference"], holdout: true }),
  q("pl-cf-02", "programming-languages", "编程语言中 C++ 标准草案与 Rust Reference 对 ABI 的定义是否有差异？", { expectedEntryIds: ["pl-fact-abi"], type: "conflict", conflictSourceIds: ["pl-cpp-draft", "pl-rust-reference"], holdout: true }),
  q("ms-cf-01", "materials-science", "Materials Project 与 NOMAD 对离子电导率的收录是否有差异？", { expectedEntryIds: ["ms-fact-ionic-conductivity"], type: "conflict", conflictSourceIds: ["ms-materials-project", "ms-nomad"], holdout: true }),
  q("ms-cf-02", "materials-science", "材料科学中 ICSD 与 AFLOW 对固态电解质晶体结构的记录是否有差异？", { expectedEntryIds: ["ms-fact-crystal-structure"], type: "conflict", conflictSourceIds: ["ms-icsd", "ms-aflow"], holdout: true }),

  // ════════════════════════════════════════════════════════════════════
  // version：old / latest / changed（每个子类 2 题，evidence 必须携带 sourceVersion）
  // ════════════════════════════════════════════════════════════════════
  q("pl-ve-01", "programming-languages", "Java SE 23 语言规范中的类型检查规则是什么？", { expectedEntryIds: ["pl-fact-type-checking"], type: "version", versionExpectation: "old", expectedSourceVersions: [{ sourceId: "pl-jls", sourceVersion: "Java SE 23" }], holdout: true }),
  q("pl-ve-02", "programming-languages", "LLVM 21 语言参考中的中间表示结构是什么？", { expectedEntryIds: ["pl-fact-ir"], type: "version", versionExpectation: "old", expectedSourceVersions: [{ sourceId: "pl-llvm-langref", sourceVersion: "LLVM 21" }], holdout: true }),
  q("pl-ve-03", "programming-languages", "Rust Reference stable 最新版本对类型系统的描述是什么？", { expectedEntryIds: ["pl-fact-type-system"], type: "version", versionExpectation: "latest", expectedSourceVersions: [{ sourceId: "pl-rust-reference", sourceVersion: "stable" }], holdout: true }),
  q("pl-ve-04", "programming-languages", "ECMAScript 2025 最新语言规范如何定义静态与运行时语义？", { expectedEntryIds: ["pl-fact-semantics"], type: "version", versionExpectation: "latest", expectedSourceVersions: [{ sourceId: "pl-ecma262", sourceVersion: "ECMAScript 2025" }], holdout: true }),
  q("ms-ve-01", "materials-science", "Materials Project 2026-08 数据版本中的离子电导率字段如何？", { expectedEntryIds: ["ms-fact-ionic-conductivity"], type: "version", versionExpectation: "changed", expectedSourceVersions: [{ sourceId: "ms-materials-project", sourceVersion: "2026-08" }], holdout: true }),
  q("ms-ve-02", "materials-science", "NOMAD 2026-08 版本数据集中的活化能字段如何？", { expectedEntryIds: ["ms-fact-activation-energy"], type: "version", versionExpectation: "changed", expectedSourceVersions: [{ sourceId: "ms-nomad", sourceVersion: "2026-08" }], holdout: true }),

  // ════════════════════════════════════════════════════════════════════
  // tenant-space：跨 tenant/space 负向（生产端口 + 真实 PG）
  // ════════════════════════════════════════════════════════════════════
  q("pl-ts-01", "programming-languages", "编程语言中的类型检查发生在编译期还是运行期？", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true, type: "tenant-space", tenantId: "tenant-b", space: "meta", holdout: true }),
  q("pl-ts-02", "programming-languages", "编程语言中的类型检查发生在编译期还是运行期？", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true, type: "tenant-space", tenantId: "default", space: "private-other", holdout: true }),
  q("ms-ts-01", "materials-science", "固态电解质的离子电导率达到多少才适合用于全固态电池？", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true, type: "tenant-space", tenantId: "tenant-b", space: "meta", holdout: true }),
  q("ms-ts-02", "materials-science", "固态电解质的离子电导率达到多少才适合用于全固态电池？", { authoritative: false, expectedEntryIds: [], expectNoKnowledge: true, type: "tenant-space", tenantId: "default", space: "private-other", holdout: true }),

  // ════════════════════════════════════════════════════════════════════
  // 多 Domain 组合（resolver 前 3 必须包含全部 expectedDomains）
  // ════════════════════════════════════════════════════════════════════
  q("pl-md-01", "programming-languages", "使用编程语言处理 Materials Project 的晶体结构数据", { authoritative: false, expectedEntryIds: [], expectedDomains: ["materials-science", "programming-languages"] }),
  q("pl-md-02", "programming-languages", "用类型检查分析 NOMAD 材料数据", { authoritative: false, expectedEntryIds: [], expectedDomains: ["materials-science", "programming-languages"] }),
  q("pl-md-03", "programming-languages", "编译器能否处理材料数据库 Materials Project 的数据导出", { authoritative: false, expectedEntryIds: [], expectedDomains: ["materials-science", "programming-languages"] }),
  q("pl-md-04", "programming-languages", "语言规范与固态电解质数据建模", { authoritative: false, expectedEntryIds: [], expectedDomains: ["materials-science", "programming-languages"] }),
  q("ms-md-01", "materials-science", "固态电解质数据需要哪种编程语言分析", { authoritative: false, expectedEntryIds: [], expectedDomains: ["materials-science", "programming-languages"] }),
  q("ms-md-02", "materials-science", "Materials Project 的数据模型与类型系统", { authoritative: false, expectedEntryIds: [], expectedDomains: ["materials-science", "programming-languages"] }),
  q("ms-md-03", "materials-science", "材料科学中的中间表示与离子电导率", { authoritative: false, expectedEntryIds: [], expectedDomains: ["materials-science", "programming-languages"] }),
  q("ms-md-04", "materials-science", "NOMAD 数据与程序分析工具", { authoritative: false, expectedEntryIds: [], expectedDomains: ["materials-science", "programming-languages"] }),

  // ════════════════════════════════════════════════════════════════════
  // 混淆题（近义 domain 干扰；目标域在 top3 或 primaryDomain=目标域）
  // ════════════════════════════════════════════════════════════════════
  q("pl-ds-01", "programming-languages", "计算机科学 与 编程语言 的类型检查有什么不同", { authoritative: false, expectedEntryIds: [], distractorDomain: "computer-science" }),
  q("pl-ds-02", "programming-languages", "计算机科学 领域的 编译器 与 程序分析 工具", { authoritative: false, expectedEntryIds: [], distractorDomain: "computer-science" }),
  q("ms-ds-01", "materials-science", "化学 视角下的 固态电解质 与 离子电导率", { authoritative: false, expectedEntryIds: [], distractorDomain: "chemistry" }),
  q("ms-ds-02", "materials-science", "化学 与 材料数据库 中的 电化学稳定窗口", { authoritative: false, expectedEntryIds: [], distractorDomain: "chemistry" }),
];
