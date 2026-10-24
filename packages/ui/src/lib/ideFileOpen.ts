/**
 * IDE 宿主：把「用内置文件查看器打开」的请求改投给 IDE 编辑器。
 *
 * 调用方是 `useAppPanels`（全站唯一的内置查看器入口）。放在 lib 下而不是 App.tsx，
 * 是因为它属于共享 UI 层，App 与 hook 都能引用而不产生循环依赖。
 */
import {
  decodeFilePathUriEscapes,
  isAbsoluteFilePath,
  joinFilePath,
} from "@/lib/path.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

/**
 * 消息里的文件链接常是 `./a/b` 或含 `..` 的相对路径；直接拼给 IDE 会因
 * `.`/`..` 段解析失败而静默打不开。这里按段归一化（根之上的 `..` 保留原样，
 * 让打开端报“找不到”而不是指错文件）。
 */
function normalizeIdeFilePath(path: string): string {
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const segments: string[] = [];
  for (const segment of path.split(/[\\/]+/)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }
  return segments.join(separator);
}

/**
 * 返回 true 表示已交给 IDE，调用方不要再弹内置查看器。
 *
 * IDE 宿主里只要是「点一个具体的本地文件」，就统一落到 IDE 编辑器，避免同一个
 * 文件在对话链接、预览卡片、变更文件行、工具调用行、侧栏文件树里表现不一致：
 * - `file`：直接打开，带行号/列号定位。
 * - `patch` / `multi-file-diff` / `text`：它们都指向真实文件，文件本身在 IDE 里
 *   更可读，diff 上下文交给 IDE 自己的 git 能力。
 *
 * 保持内置预览的是 media/pdf/pptx/image（IDE 里只会变成二进制）和 code-review
 * （它展示的是审查意见，不是文件正文）。
 */
const IDE_EDITOR_SOURCE_TYPES = new Set<CodeViewerSource["type"]>([
  "file",
  "patch",
  "multi-file-diff",
  "text",
]);

export function openFileSourceInIdeEditor(
  source: CodeViewerSource,
  fallbackWorkspacePath: string,
  platform: {
    openExternalFile?: (
      path: string,
      location?: { line?: number; column?: number },
    ) => void | Promise<unknown>;
  },
): boolean {
  if (!IDE_EDITOR_SOURCE_TYPES.has(source.type)) return false;
  const sourcePath = source.type === "file" ? source.path : source.path?.trim();
  if (!sourcePath) return false;
  const decoded = decodeFilePathUriEscapes(sourcePath);
  const joined = isAbsoluteFilePath(decoded)
    ? decoded
    : joinFilePath(source.workspacePath?.trim() || fallbackWorkspacePath, decoded);
  const absolute = normalizeIdeFilePath(joined);
  if (!isAbsoluteFilePath(absolute)) return false;
  const location =
    source.type === "file"
      ? {
          ...(source.lineNumber ? { line: source.lineNumber } : {}),
          ...(source.columnNumber ? { column: source.columnNumber } : {}),
        }
      : {};
  void platform.openExternalFile?.(
    absolute,
    Object.keys(location).length > 0 ? location : undefined,
  );
  return true;
}
