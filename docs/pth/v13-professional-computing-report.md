# v1.3 专业计算权威验收报告（GO）

- **evaluatedCommit**: `cf8615c393d648f554988cfda58fa79a4ec7ac65`（main，验收开始与结束时工作树均 clean）
- **验收日期**: 2026-08-21
- **决策**: **GO**（唯一权威 envelope：`docs/pth/v13-professional-computing-envelope.json`，reasons=0）
- **计划**: `docs/superpowers/plans/2026-08-19-v13-professional-computing.md` Task 10

## 1. 权威门禁

| 门禁 | 结果 |
|---|---|
| evaluator 双跑 | **PASS / BYTE-IDENTICAL** |
| evaluator 精确分母 | memoryTypes=5 · adapters=7 · realJobCases=4 · notebooks=4 · authorizationProbes=7 · sabotageProbes=12 |
| 12 项 sabotage flip matrix | 12/12 单点破坏只翻转自身映射门 |
| focused | 8 files，**82 tests：82 passed / 0 failed / 0 skipped** |
| full regression | 351 files，**3062 tests：3053 passed / 0 failed / 9 skipped** |
| full skip manifest | 冻结一致：仅 `test/pth-execution/sandbox-security.integration.test.ts` 9 项，无新增 |
| lint | exit 0（pth-boundaries 0 违规；pth-config 通过） |
| build | exit 0（六项 operator-console assets 复制成功） |
| N29 envelope | **MIN_INNER_LOOP_GO**（`docs/pth/n29-minimal-intake-acceptance.json`） |
| N30 envelope | **GO**（`docs/pth/n30-runtime-observatory-envelope.json`） |
| N33 envelope | **GO**（`docs/pth/n33-operator-console-envelope.json`） |
| implementation tree | clean，envelope 绑定 `cf8615c` |

## 2. 真实工具链证据（focused 全部 passed）

- **Assembly**：x86-64 / aarch64 / riscv64 三 ISA byte-sum build-run-disassemble 真实通过（v13-asm-toolchain，qemu-user + binutils 2.40）。
- **Lean 4**：Mathlib @ `db584cd6…` 环定理 `two_mul_add_two` prove 真实通过，axioms 无 `sorryAx`。
- **Wolfram**：无 licensed kernel → 真实 `license-unavailable` EVALUATION-INCOMPLETE，不冒充。
- **Computational Chemistry**：QE 6.7 Si SCF 真实收敛；CP2K 2023.1 注册并通过真实计算路径。
- **Jupyter**：`pi-platform-jupyter-1`（notebook 7.6.1 == committed lock）clean-kernel Run-All 四份教程真实执行，validate.py 独立复核，领域 Role 复核签名。
- **共享记忆**：同一 index entry 路由两个专业 Role 到同一 artifact，正文零复制，各自 Working Set 预算独立。
- **Replica / handoff**：四专业 Worker Replica 独立可寻址；`run→intake` 与 `run→optimize` 产生新 workId、完整 causation、源 mode 不可原地改。

## 3. 环境稳定性措施

验收前清理全部陈旧 testcontainers；focused 限 `--maxWorkers=2`，full 限 `--maxWorkers=4`；focused 真实工具链运行后重启 `v13-asm-toolchain` 再做 full。监控峰值：toolchain 内存峰值 1.82 GiB / 7.82 GiB（23.3%），测试容器峰值 16 个，全程未触资源耗尽。

## 4. 结论

M0/P0–P6 与 Task 10 权威门全部满足，v1.3.0 具备发布条件。本报告/envelope 绑定 `cf8615c`；发布版本号与发布物以 `scripts/release.sh` 校验为准。
