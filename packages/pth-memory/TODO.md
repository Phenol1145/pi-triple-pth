# pth-memory 包待办（2026-08-15 拆分归位）

> 本包只维护记忆域。核心闭环之外的长尾在此逐包评估后再动手（拆分决策 D）。

## 拆分后立即要做
- [ ] memory_entries 表 DDL 从 core schema.ts 抽到本包（MEMORY_TABLE_SQL），core 引用
- [ ] 测试文件迁入本包 test/（memory-policy / memory-index / read-only-query / skill-format / memory-store）

## 记忆域长尾（归位自主 TODO）
- [ ] H3 后续：可见性谓词下推 SQL（当前 fail-closed 要求 SELECT meta——可演进为服务端过滤）
- [ ] H5 后续：recall 与 query/retrieve 的可见性过滤统一成单一入口
- [ ] H6 后续：store.update 的 meta 合并改为字段白名单（worker 面已挡，store 层纵深）
- [ ] H7 后续：worker-role/space-reg 装配恢复加来源校验（prompt 层拒写已上，信任链仍需）
- [ ] B4 Phase 2：skills.get 真实接线 + Level 0 清单 / Level 1 全文两级检索
- [ ] B4 Phase 3：memory-keeper 专项维护面 + 不可变语义 + controller:adversarial 审核角色
- [ ] B4 Phase 4：SKILL.md → skill 条目映射定稿（0.13 转化落点）
- [ ] N1b 百科写入矛盾检测；N4 生态转化 pipeline（记忆侧 skill 条目化）
- [ ] 归档定期 trigger 接线（N7 尾件）
- [ ] memoryScope:"own" 读侧过滤（当前只给 write 盖章）

## 评估后待裁
- 低价值/设计储备项拆分完成后单独裁决（对照主 TODO）
