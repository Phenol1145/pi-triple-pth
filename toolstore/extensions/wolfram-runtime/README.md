# wolfram-runtime

Wolfram 符号计算运行时扩展：固定命令面 `probe / evaluate / verify`。

- 固定 `.wl` 文件协议：表达式 JSON 转义后经 `ToExpression[..., InputForm]`；
  绝不执行 shell 转义或任意文件导入。
- license 数据由运行时安全注入，绝不进入任务载荷、产物、审计日志、
  Notebook 单元格或浏览器响应。
- 无 licensed kernel 时 probe 明确 `license-unavailable`——验收记录
  `EVALUATION-INCOMPLETE`，绝不 skip 或用 SymPy 冒充。
