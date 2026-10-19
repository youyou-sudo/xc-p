import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  // schema 的唯一来源；改动后跑 bun run db:generate 生成 v4+ 迁移
  schema: './src/core/schema.ts',
  out: './drizzle',
})
