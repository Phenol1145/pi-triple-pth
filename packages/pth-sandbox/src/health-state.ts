/**
 * health-state.ts —— sandbox 侧 degraded 观测（S1-5）。
 *
 * 跟踪依赖条件：共享密钥缺失 / bridge token 缺失 / 池满拒绝 / 编译并发饱和。
 * 任一条件成立 → degraded；/kernel/status 暴露 { degraded, reasons }；状态跃迁经 onTransition 回调打日志。
 * 不在此处改动 /health 与 /ready 语义（readiness 拆分归 v2 P2-6，已由 exec-api/kernel-host 实现）。
 */

export interface SandboxHealthStatus {
  degraded: boolean;
  reasons: string[];
}

export interface HealthStateOptions {
  onTransition?: (status: SandboxHealthStatus) => void;
}

export class SandboxHealthState {
  private readonly reasons = new Set<string>();
  private degraded = false;
  private readonly onTransition?: (status: SandboxHealthStatus) => void;

  constructor(opts: HealthStateOptions = {}) {
    this.onTransition = opts.onTransition;
  }

  set(reason: string, active: boolean): void {
    if (active) this.reasons.add(reason);
    else this.reasons.delete(reason);
    const next = this.reasons.size > 0;
    if (next !== this.degraded) {
      this.degraded = next;
      const status = this.status();
      try {
        this.onTransition?.(status);
      } catch { /* 观测回调失败不影响主链路 */ }
    }
  }

  status(): SandboxHealthStatus {
    return { degraded: this.degraded, reasons: [...this.reasons].sort() };
  }
}
