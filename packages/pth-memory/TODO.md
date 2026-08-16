# pth-memory 包待办（2026-08-15 拆分归位）

> 本包只维护记忆域。核心闭环之外的长尾在此逐包评估后再动手（拆分决策 D）。

## 拆分后立即要做
- [x] memory_entries 表 DDL 从 core schema.ts 抽到本包（MEMORY_SCHEMA_SQL），core 引用
- [x] 测试文件迁入本包 test/（memory-policy / memory-index / read-only-query / skill-format / memory-store）

## 记忆域长尾（归位自主 TODO）
- [x] H3 后续：可见性谓词下推 SQL（2026-08-17：参数化 WHERE 下推 + requireMetaColumn fail-closed）
- [x] H5 后续：recall 与 query/retrieve 的可见性过滤统一成单一入口（2026-08-17：filterVisibleEntries/Rows）
- [x] H6 后续：store.update 的 meta 合并改为字段白名单（2026-08-17：sanitizeMetaPatch）
- [x] H7 后续：worker-role/space-reg 装配恢复加来源校验（2026-08-17：recovery-validation.ts）
- [x] B4 Phase 2：skills.get 真实接线 + Level 0 清单 / Level 1 全文两级检索
- [x] B4 Phase 3：memory-keeper 专项维护面 + 不可变语义 + controller:adversarial 审核（`skills.maintain` 仅 memory-keeper、store 层 skill update 需 force、W5 staged 提案/审核/批准/执行 + `controller:adversarial` 治理角色 + PTC entries + gateway approve 流）
- [x] B4 Phase 4：SKILL.md → skill 条目映射定稿（`parseSkillMarkdown`——四段式映射，0.13 转化落点）
- [x] N1b 百科写入矛盾检测（`wiki.ts validateWikiWrite`）；N4 生态转化 pipeline（记忆侧 skill 条目化：`importSkillMarkdown`）
- [x] 归档定期 trigger 接线（N7 尾件——memory-sweep-trigger.ts，默认每天）
- [x] memoryScope:"own" 读侧过滤（2026-08-17：memory-scope.ts get/retrieve/query）
- [x] readSource/toolstore symlink 防线（根 TODO 归位项，2026-08-16 补账入列）→
  执行入口 `docs/superpowers/plans/2026-08-16-pth-sandbox-hardening.md` S0-4（`4a3b466`）

## 评估结论（2026-08-15 拆分后；2026-08-16 补账）
- 本包项全部**保留**：B4 Phase 2–4 已全落；N1b/N4 已落（2026-08-15）；H3/H5/H6/H7 为安全纵深，随批推进；无砍项。
- 补账结论：根 TODO 曾把 readSource/toolstore symlink 归到本包，但此前未入列——现补入并指向沙箱加固计划。
