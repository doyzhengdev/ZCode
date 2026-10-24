/**
 * IDE → Web 的主动推送通道（Java → JS 方向）。
 *
 * 插件侧（ZCodePanel）通过 executeJavaScript 调 `window.__zcodeIdeMessage(json)`，
 * 与 JS → Java 的 `window.__ZCODE_IDE_QUERY__` 相对。目前消费两种消息：
 * - `{op:"filesToInput", refs:[{path, kind}]}` —— IDE 项目树右键「发送到 ZCode 对话框」；
 * - `{op:"selectionToInput", refs:[{path, startLine, endLine}]}` —— 编辑器选区右键（只发引用，不发原文）。
 */
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";

interface IdeFileRef {
  path: string;
  kind?: "file" | "directory";
  startLine?: number;
  endLine?: number;
}

interface IdePushMessage {
  op?: string;
  refs?: IdeFileRef[];
}

declare global {
  interface Window {
    /** 插件注入：IDE 主动推送给页面的消息入口。 */
    __zcodeIdeMessage?: (json: string) => void;
  }
}

export interface IdePushWorkspace {
  path?: string;
  identity?: string;
}

export function installIdeContextPush(getWorkspace: () => IdePushWorkspace): void {
  window.__zcodeIdeMessage = (json: string) => {
    let message: IdePushMessage;
    try {
      message = JSON.parse(json) as IdePushMessage;
    } catch (error) {
      console.warn("[web-ide] invalid ide push message", error);
      return;
    }
    if (message.op === "filesToInput" && message.refs?.length) {
      void insertFileRefs(message.refs, getWorkspace());
      return;
    }
    if (message.op === "selectionToInput" && message.refs?.length) {
      void insertSelectionRefs(message.refs, getWorkspace());
      return;
    }
    // 拼错 op 时不能静默：否则 IDE 侧加了新消息、页面没消费，表现为点击无反应。
    console.warn("[web-ide] unhandled ide push op", message.op);
  };
}

/** 归一化到正斜杠并去尾分隔符；Windows 下 IDE 与 UI 的分隔符写法可能不同。 */
function normalizeForCompare(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function toRelativePath(path: string, workspacePath: string): string | null {
  const full = normalizeForCompare(path);
  const root = normalizeForCompare(workspacePath);
  if (full === root) return "";
  if (root && full.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return full.slice(root.length + 1);
  }
  return null;
}

/**
 * 逐个 prepend（倒序插入保持用户看到的顺序）。插入请求是“最后一次生效”的单槽状态，
 * 同一轮发多条只保留最后一条，所以这里按帧间隔提交，等 composer 消费完再发下一条。
 */
async function insertFileRefs(refs: IdeFileRef[], workspace: IdePushWorkspace): Promise<void> {
  const workspacePath = workspace.path?.trim();
  if (!workspacePath) {
    console.warn("[web-ide] filesToInput ignored: no workspace");
    return;
  }
  const prefills: ComposerMentionPrefill[] = refs.map((ref) => {
    const kind = ref.kind === "directory" ? "directory" : "file";
    const relative = toRelativePath(ref.path, workspacePath);
    // 工作区外的绝对路径直接作为引用值；mention 的链接目标支持绝对路径。
    const value = relative ?? normalizeForCompare(ref.path);
    const name = value.split("/").pop() || value;
    return {
      id: `ide-file:${ref.path}`,
      category: "files" as const,
      label: name,
      value,
      markdown: buildFileMentionMarkdown(value, name, kind),
      data: { kind, path: normalizeForCompare(ref.path), relativePath: relative ?? undefined },
    };
  });
  for (const mention of prefills.reverse()) {
    useZCodeSessionStore
      .getState()
      .requestComposerTextInsert(
        workspacePath,
        mention.markdown,
        workspace.identity,
        mention,
        "prepend-if-missing",
      );
    await nextFrame();
  }
}

/**
 * 编辑器选区：插入「完整文件路径 + GitHub 行锚点」，如
 * `E:/gitee/zcode-ide/src/a.ts#L12-L20`，不带选中原文。
 *
 * 模型能按路径和行号自己读文件，避免把大段代码重复塞进 prompt；
 * `#Lx-Ly` 也是 ZCode 的 markdown 文件链接解析器接受的写法。
 */
async function insertSelectionRefs(
  refs: IdeFileRef[],
  workspace: IdePushWorkspace,
): Promise<void> {
  const workspacePath = workspace.path?.trim();
  if (!workspacePath) {
    console.warn("[web-ide] selectionToInput ignored: no workspace");
    return;
  }
  for (const ref of refs) {
    if (!ref.path) continue;
    // 完整路径统一成正斜杠：反斜杠在部分上下文里会被当转义符。
    const fullPath = normalizeForCompare(ref.path);
    const startLine = ref.startLine && ref.startLine > 0 ? ref.startLine : 1;
    const endLine = ref.endLine && ref.endLine >= startLine ? ref.endLine : startLine;
    const anchor = endLine > startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
    const markdown = `${fullPath}${anchor}`;
    useZCodeSessionStore
      .getState()
      .requestComposerTextInsert(
        workspacePath,
        markdown,
        workspace.identity,
        undefined,
        "prepend-if-missing",
      );
    await nextFrame();
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 80));
}
