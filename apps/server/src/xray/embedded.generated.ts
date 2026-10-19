/**
 * 内嵌 Xray 二进制的构建产物描述（占位版本，随源码提交）。
 *
 * - 直接跑源码（bun run start / bun --watch）时：`EMBEDDED_XRAY === null`，
 *   二进制解析回退到 XRAY_BINARY / PATH / .tools。
 * - 执行 `bun run build:exe` 时：构建脚本会先按目标平台下载 Xray，随后用生成内容
 *   **临时覆盖本文件**（把 xray[.exe] 以 `with { type: "file" }` 嵌入可执行文件），
 *   编译结束后再恢复为本占位版本。因此不要手改本文件。
 */
export interface EmbeddedXrayInfo {
  /** bun 的内嵌文件路径（编译后形如 B:/~BUN/root/...）；用 readFileSync 读取后解出到 DATA_DIR/bin */
  file: string
  /** Xray 发行版本 tag，例如 v26.3.27 */
  version: string
  platform: 'win32' | 'linux' | 'darwin'
  arch: 'x64' | 'arm64' | 'arm'
  filename: 'xray' | 'xray.exe'
  /** 内嵌二进制的 SHA256（运行时解出后校验） */
  sha256: string
  size: number
}

export const EMBEDDED_XRAY: EmbeddedXrayInfo | null = null
