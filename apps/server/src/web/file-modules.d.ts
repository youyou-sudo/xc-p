// 让 TypeScript 认识 Bun 的 file import（with { type: "file" } 返回文件路径字符串）。
declare module "*.html" {
  const path: string
  export default path
}
declare module "*.css" {
  const path: string
  export default path
}
declare module "*.js" {
  const path: string
  export default path
}
declare module "*.ndjson" {
  const path: string
  export default path
}
declare module "*.ico" {
  const path: string
  export default path
}
declare module "*.svg" {
  const path: string
  export default path
}
declare module "*.png" {
  const path: string
  export default path
}
declare module "*.woff2" {
  const path: string
  export default path
}
declare module "*.json" {
  const path: string
  export default path
}
// 内嵌 Xray 二进制（scripts/build-exe.ts 生成 embedded.generated.ts 时使用）
declare module "*.bin" {
  const path: string
  export default path
}
declare module "*.exe" {
  const path: string
  export default path
}
