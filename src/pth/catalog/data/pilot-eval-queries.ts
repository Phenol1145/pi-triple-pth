/**
 * catalog/data/pilot-eval-queries.ts — N23 K5 评测批：双域冻结查询集。
 *
 * 每个域 30 条（共 60），id 形如 pl-01 / ms-01；查询文本必须能被
 * resolver 的 alias 扫描命中（覆盖缺口会被 domain recall 指标自然暴露）。
 * expectedEntryIds 为人工可复核的期望 top-5 命中 knowledge entry。
 */

export interface PilotEvalQuery {
  id: string; // 全局唯一
  domain: string; // 期望 domain
  text: string; // 冻结查询（中文）
  authoritative: boolean; // 是否需要权威事实/证据（§12.3）
  expectedEntryIds: string[]; // 期望 top-5 命中的 knowledge entry（≥1）
}

export const PILOT_EVAL_QUERIES: PilotEvalQuery[] = [
  // ── programming-languages（30 条）──
  { id: "pl-01", domain: "programming-languages", text: "Java 编程语言中，类型检查发生在编译期还是运行期？", authoritative: true, expectedEntryIds: ["pl-fact-type-checking"] },
  { id: "pl-02", domain: "programming-languages", text: "Rust 编程语言的类型检查如何帮助在运行前排除内存安全问题？", authoritative: true, expectedEntryIds: ["pl-fact-type-checking"] },
  { id: "pl-03", domain: "programming-languages", text: "C++ 编译器的类型检查为什么允许某些隐式转换？", authoritative: true, expectedEntryIds: ["pl-fact-type-checking"] },
  { id: "pl-04", domain: "programming-languages", text: "Python 编程语言是动态类型还是静态类型？其类型检查在何时执行？", authoritative: true, expectedEntryIds: ["pl-fact-type-checking"] },
  { id: "pl-05", domain: "programming-languages", text: "编程语言中的类型检查与类型推导有什么区别？", authoritative: true, expectedEntryIds: ["pl-fact-type-checking"] },
  { id: "pl-06", domain: "programming-languages", text: "什么是编程语言的类型检查器？它会拒绝哪一类程序？", authoritative: true, expectedEntryIds: ["pl-fact-type-checking"] },
  { id: "pl-07", domain: "programming-languages", text: "LLVM 中间表示在编译器后端中起什么作用？", authoritative: true, expectedEntryIds: ["pl-fact-ir"] },
  { id: "pl-08", domain: "programming-languages", text: "Java 编程语言的字节码属于哪一种中间表示？", authoritative: true, expectedEntryIds: ["pl-fact-ir"] },
  { id: "pl-09", domain: "programming-languages", text: "Rust 编译器的 MIR 中间表示主要用于哪些分析？", authoritative: true, expectedEntryIds: ["pl-fact-ir"] },
  { id: "pl-10", domain: "programming-languages", text: "编译器为什么要把源码先转成中间表示而不是直接生成目标代码？", authoritative: true, expectedEntryIds: ["pl-fact-ir"] },
  { id: "pl-11", domain: "programming-languages", text: "Clang 这类编译器生成 LLVM 中间表示之后还会做哪些处理？", authoritative: true, expectedEntryIds: ["pl-fact-ir"] },
  { id: "pl-12", domain: "programming-languages", text: "中间表示需要保留程序语言的哪些语义信息？", authoritative: true, expectedEntryIds: ["pl-fact-ir"] },
  { id: "pl-13", domain: "programming-languages", text: "编译器把中间表示翻译为目标机器码时，指令选择做什么？", authoritative: true, expectedEntryIds: ["pl-fact-codegen"] },
  { id: "pl-14", domain: "programming-languages", text: "LLVM 编译器在代码生成阶段如何处理寄存器分配？", authoritative: true, expectedEntryIds: ["pl-fact-codegen"] },
  { id: "pl-15", domain: "programming-languages", text: "编程语言的编译器后端进行代码生成通常包括哪些阶段？", authoritative: true, expectedEntryIds: ["pl-fact-codegen"] },
  { id: "pl-16", domain: "programming-languages", text: "JIT 编译器在运行时进行代码生成，与静态编译的代码生成有什么不同？", authoritative: true, expectedEntryIds: ["pl-fact-codegen"] },
  { id: "pl-17", domain: "programming-languages", text: "Rust 编译器的代码生成直接输出目标代码还是先经过汇编器？", authoritative: true, expectedEntryIds: ["pl-fact-codegen"] },
  { id: "pl-18", domain: "programming-languages", text: "编译器进行代码生成时如何利用 ABI 决定参数传递方式？", authoritative: true, expectedEntryIds: ["pl-fact-abi"] },
  { id: "pl-19", domain: "programming-languages", text: "C 语言 ABI 在编译器层面规定函数参数如何传递？", authoritative: true, expectedEntryIds: ["pl-fact-abi"] },
  { id: "pl-20", domain: "programming-languages", text: "Rust 编程语言默认使用哪种 ABI？如何声明 C ABI 接口？", authoritative: true, expectedEntryIds: ["pl-fact-abi"] },
  { id: "pl-21", domain: "programming-languages", text: "编译器生成的符号名为什么要遵循 ABI 的名称修饰约定？", authoritative: true, expectedEntryIds: ["pl-fact-abi"] },
  { id: "pl-22", domain: "programming-languages", text: "不同 C++ 编译器编译出的库能互相链接吗？ABI 兼容性如何判断？", authoritative: true, expectedEntryIds: ["pl-fact-abi"] },
  { id: "pl-23", domain: "programming-languages", text: "ABI 与 API 在编程语言和编译器层面有什么区别？", authoritative: true, expectedEntryIds: ["pl-fact-abi"] },
  { id: "pl-24", domain: "programming-languages", text: "JVM 字节码调用约定是否属于编程语言 ABI 的范畴？", authoritative: true, expectedEntryIds: ["pl-fact-abi"] },
  { id: "pl-25", domain: "programming-languages", text: "C++ 编程语言的内存模型如何定义数据竞争？", authoritative: true, expectedEntryIds: ["pl-fact-memory-model"] },
  { id: "pl-26", domain: "programming-languages", text: "Java 编程语言内存模型中的 happens-before 关系有什么作用？", authoritative: true, expectedEntryIds: ["pl-fact-memory-model"] },
  { id: "pl-27", domain: "programming-languages", text: "Rust 编程语言的所有权模型与底层内存模型是什么关系？", authoritative: true, expectedEntryIds: ["pl-fact-memory-model"] },
  { id: "pl-28", domain: "programming-languages", text: "编程语言内存模型为什么需要区分顺序一致性与弱内存序？", authoritative: true, expectedEntryIds: ["pl-fact-memory-model"] },
  { id: "pl-29", domain: "programming-languages", text: "C++11 编程语言引入内存模型后，volatile 还能用于线程同步吗？", authoritative: true, expectedEntryIds: ["pl-fact-memory-model"] },
  { id: "pl-30", domain: "programming-languages", text: "编译器与 CPU 的指令重排在编程语言内存模型中如何被约束？", authoritative: true, expectedEntryIds: ["pl-fact-memory-model"] },

  // ── materials-science（30 条）──
  { id: "ms-01", domain: "materials-science", text: "固态电解质的离子电导率达到多少才适合用于全固态电池？", authoritative: true, expectedEntryIds: ["ms-fact-ionic-conductivity"] },
  { id: "ms-02", domain: "materials-science", text: "材料数据库 Materials Project 如何标注固态电解质的离子电导率？", authoritative: true, expectedEntryIds: ["ms-fact-ionic-conductivity"] },
  { id: "ms-03", domain: "materials-science", text: "提高固态电解质离子电导率的主要材料设计策略有哪些？", authoritative: true, expectedEntryIds: ["ms-fact-ionic-conductivity"] },
  { id: "ms-04", domain: "materials-science", text: "固态电解质的电子电导与离子电导率比值为什么必须足够低？", authoritative: true, expectedEntryIds: ["ms-fact-ionic-conductivity"] },
  { id: "ms-05", domain: "materials-science", text: "NOMAD 数据库中的离子电导率数据如何用于固态电解质筛选？", authoritative: true, expectedEntryIds: ["ms-fact-ionic-conductivity"] },
  { id: "ms-06", domain: "materials-science", text: "材料科学中常用的离子电导率单位是什么？", authoritative: true, expectedEntryIds: ["ms-fact-ionic-conductivity"] },
  { id: "ms-07", domain: "materials-science", text: "固态电解质的离子迁移活化能 Ea 低于多少 eV 才被认为适合应用？", authoritative: true, expectedEntryIds: ["ms-fact-activation-energy"] },
  { id: "ms-08", domain: "materials-science", text: "Arrhenius 关系如何描述固态电解质离子电导率随温度的变化？", authoritative: true, expectedEntryIds: ["ms-fact-activation-energy"] },
  { id: "ms-09", domain: "materials-science", text: "固态电解质的活化能通常用哪种实验方法测量？", authoritative: true, expectedEntryIds: ["ms-fact-activation-energy"] },
  { id: "ms-10", domain: "materials-science", text: "NOMAD 数据中的活化能字段对固态电解质筛选有什么价值？", authoritative: true, expectedEntryIds: ["ms-fact-activation-energy"] },
  { id: "ms-11", domain: "materials-science", text: "活化能与离子电导率的温度依赖性在材料科学中如何关联？", authoritative: true, expectedEntryIds: ["ms-fact-activation-energy"] },
  { id: "ms-12", domain: "materials-science", text: "为什么固态电解质研究通常追求 Ea 小于 0.4 eV？", authoritative: true, expectedEntryIds: ["ms-fact-activation-energy"] },
  { id: "ms-13", domain: "materials-science", text: "固态电解质的电化学稳定窗口如何决定其可匹配的电极材料？", authoritative: true, expectedEntryIds: ["ms-fact-electrochemical-window"] },
  { id: "ms-14", domain: "materials-science", text: "如何用 Materials Project 数据估算固态电解质的稳定电压窗口？", authoritative: true, expectedEntryIds: ["ms-fact-electrochemical-window"] },
  { id: "ms-15", domain: "materials-science", text: "稳定电压窗口较窄的固态电解质在高压正极下会发生什么？", authoritative: true, expectedEntryIds: ["ms-fact-electrochemical-window"] },
  { id: "ms-16", domain: "materials-science", text: "材料科学中，固态电解质的稳定电压窗口由哪些能级或电位决定？", authoritative: true, expectedEntryIds: ["ms-fact-electrochemical-window"] },
  { id: "ms-17", domain: "materials-science", text: "NOMAD 是否提供固态电解质稳定电压窗口相关的计算数据？", authoritative: true, expectedEntryIds: ["ms-fact-electrochemical-window"] },
  { id: "ms-18", domain: "materials-science", text: "硫化物固态电解质的稳定电压窗口为什么通常比较窄？", authoritative: true, expectedEntryIds: ["ms-fact-electrochemical-window"] },
  { id: "ms-19", domain: "materials-science", text: "固态电解质与锂金属负极的界面稳定性如何影响电池循环？", authoritative: true, expectedEntryIds: ["ms-fact-interface-stability"] },
  { id: "ms-20", domain: "materials-science", text: "材料数据库 Materials Project 能用于筛选对金属锂稳定的固态电解质吗？", authoritative: true, expectedEntryIds: ["ms-fact-interface-stability"] },
  { id: "ms-21", domain: "materials-science", text: "固态电解质与电极之间理想的 SEI 应具备哪些性质？", authoritative: true, expectedEntryIds: ["ms-fact-interface-stability"] },
  { id: "ms-22", domain: "materials-science", text: "NOMAD 数据如何支持固态电解质界面稳定性的研究？", authoritative: true, expectedEntryIds: ["ms-fact-interface-stability"] },
  { id: "ms-23", domain: "materials-science", text: "界面副反应对固态电解质的离子电导率有什么影响？", authoritative: true, expectedEntryIds: ["ms-fact-interface-stability"] },
  { id: "ms-24", domain: "materials-science", text: "材料科学中如何评价固态电解质与高压正极的界面稳定性？", authoritative: true, expectedEntryIds: ["ms-fact-interface-stability"] },
  { id: "ms-25", domain: "materials-science", text: "石榴石型固态电解质的晶体结构为何有利于锂离子传导？", authoritative: true, expectedEntryIds: ["ms-fact-crystal-structure"] },
  { id: "ms-26", domain: "materials-science", text: "Materials Project 中的晶体结构信息如何辅助固态电解质设计？", authoritative: true, expectedEntryIds: ["ms-fact-crystal-structure"] },
  { id: "ms-27", domain: "materials-science", text: "固态电解质晶体结构中的扩散通道指什么？", authoritative: true, expectedEntryIds: ["ms-fact-crystal-structure"] },
  { id: "ms-28", domain: "materials-science", text: "ICSD 与 AFLOW 等材料数据库如何提供固态电解质的晶体结构数据？", authoritative: true, expectedEntryIds: ["ms-fact-crystal-structure"] },
  { id: "ms-29", domain: "materials-science", text: "材料科学中，晶体结构对离子电导率的决定作用体现在哪里？", authoritative: true, expectedEntryIds: ["ms-fact-crystal-structure"] },
  { id: "ms-30", domain: "materials-science", text: "NOMAD 与 Materials Project 的晶体结构数据可以互相补充吗？", authoritative: true, expectedEntryIds: ["ms-fact-crystal-structure"] },
];
