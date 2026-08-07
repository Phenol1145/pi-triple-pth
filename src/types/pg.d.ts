// 适配说明：pg 8.22 不自带类型定义，且零新增依赖约束下不引入 @types/pg。
// 提供 kernel storage 层所需的最小 ambient 类型面（Pool/PoolClient/PoolConfig/QueryResult），
// 采用与 @types/pg 一致的 export= + namespace 形态（保证 `pg.Pool` 类型位置可用）。
// 后续 task 若用到 Client/types 等，按需扩展。
declare module "pg" {
  export = pg;
}

declare namespace pg {
  export interface PoolConfig {
    connectionString?: string;
    max?: number;
  }

  export interface QueryResult<R = unknown> {
    rows: R[];
    rowCount: number | null;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    query(text: string, values?: unknown[]): Promise<QueryResult>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }

  export class PoolClient {
    query(text: string, values?: unknown[]): Promise<QueryResult>;
    release(err?: Error | boolean): void;
  }
}
