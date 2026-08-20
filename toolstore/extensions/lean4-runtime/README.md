# lean4-runtime

Lean 4 证明运行时扩展：固定命令面 `probe / check / buildProject`。

- 不接受任意 command/argv/shell；真实执行由 PTH `lean4-runtime-adapter` 以固定
  `lake build` / `lake env lean` 命令驱动。
- 工具链版本与 Mathlib rev 由 `deploy/professional-runtime-lock.json` 钉死
  （当前 Lean 4.33.0 + mathlib `db584cd6d46c92f209a44c0f1c829460d327499d`）。
- Mathlib cache 经共享 `.lake/packages` 目录复用，运行时禁止网络安装依赖。
