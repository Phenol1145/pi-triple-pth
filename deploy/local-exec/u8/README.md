# u8proj —— 本地执行器住户（execution/v1.1 · host）

- 上游：团队 u8proj（C 实现的小型 VM：compile/run/debug/analyze）
- 本目录：集成基线源码（U8final_C）+ 宿主构建脚本
- 构建：`bash deploy/local-exec/u8/build-u8.sh`（macOS/Linux 用 cc；Windows 用团队 u8.exe）
- 2026-08-22 集成修改（版本 0.0.2）：
  - `u8 run <programme> --reg K=V ... --io N=V ...` 非交互初始寄存器/I/O 注入
  - 无 `--reg/--io` 时保持原交互行为
  - `u8 debug` / `u8 analyze` 仍为团队待实现（协议侧暂不接线）
- 本地执行器接入：编译产物 `u8` 放入 `pth local-exec` 进程 PATH，
  engine 注册 `local-u8` backend（profile=host，pathMapping /data/workspaces）。
