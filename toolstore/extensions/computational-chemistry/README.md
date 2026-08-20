# computational-chemistry

计算化学运行时扩展：固定命令面 `probe / runPsi4 / runQuantumEspresso`。

- Psi4 与 Quantum ESPRESSO 的输入文件由 PTH adapter 服务端固定模板生成；
  不接受原始命令、宿主路径或 LLM 提供的工作流文本。
- 赝势是不可变 artifact（license + hash 记录）；运行时禁止下载替代。
- `not-converged` 是合法结构化结果，但绝不是 success。
