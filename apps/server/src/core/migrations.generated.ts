/**
 * 由 scripts/db-generate.ts 生成，勿手改。
 *
 * drizzle/0000_*.sql 是基线，描述的是 v1-v3 建表后的结果，**不会被执行**；
 * drizzle/0001_*.sql 起才映射为 version 4、5 … 依次应用。
 *
 * 生成成 TS 模块而不是运行时读目录，是为了 bun build --compile 的单文件产物仍能带上迁移。
 */
export const DRIZZLE_MIGRATIONS: { version: number; name: string; sql: string }[] = [
]
