/**
 * IDE → Web 的主动推送通道（Java → JS 方向）。
 *
 * 插件侧（ZCodePanel）通过 executeJavaScript 调 `window.__zcodeIdeMessage(json)`，
 * 与 JS → Java 的 `window.__ZCODE_IDE_QUERY__` 相对。目前消费两种消息：
 * - `{op:"filesToInput", refs:[{path, kind}]}` —— IDE 项目树右键「发送到 ZCode 对话框」，
 *   转成官方 workspace 文件树同款「加入对话」事件（末尾追加 chip），零官方补丁；
 * - `{op:"selectionToInput", refs:[{path, startLine, endLine}]}` —— 编辑器选区右键（只发引用，不发原文），
 *   转成官方代码预览同款「代码评论加入对话」事件（composer 上下文附件，不覆盖正文），零官方补丁。
 */
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import {
  WORKSPACE_FILE_ADD_TO_CHAT_EVENT,
  type WorkspaceFileDragPayload,
} from "@/lib/workspaceFileDrag.js";
import {
  CODE_COMMENT_ADD_TO_CHAT_EVENT,
  type CodeCommentPayload,
} from "@/lib/codeCommentContext.js";

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
 * 逐个转发到官方「加入对话」事件（workspace 文件树右键/拖拽同款）：
 * composer 聚焦时消费——末尾追加 chip、自动补分隔空格、拉回焦点。
 *
 * composer 只在面板聚焦时监听该事件；`dispatchEvent` 返回 false（未被消费，
 * 即无人调用 preventDefault）说明面板未聚焦，此时回退到 store 预填请求
 * （官方既有 `prepend-if-missing` 模式），宁可插到开头也不静默丢消息。
 */
async function insertFileRefs(refs: IdeFileRef[], workspace: IdePushWorkspace): Promise<void> {
  const workspacePath = workspace.path?.trim();
  if (!workspacePath) {
    console.warn("[web-ide] filesToInput ignored: no workspace");
    return;
  }
  for (const ref of refs) {
    const kind = ref.kind === "directory" ? "directory" : "file";
    const relative = toRelativePath(ref.path, workspacePath);
    // 工作区外的绝对路径直接作为引用值；mention 的链接目标支持绝对路径。
    const value = relative ?? normalizeForCompare(ref.path);
    const name = value.split("/").pop() || value;
    const payload: WorkspaceFileDragPayload = {
      type: kind,
      workspacePath,
      ...(workspace.identity ? { workspaceIdentity: workspace.identity } : {}),
      path: normalizeForCompare(ref.path),
      relativePath: value,
      name,
    };
    const consumed = !window.dispatchEvent(
      new CustomEvent(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, {
        cancelable: true,
        detail: payload,
      }),
    );
    if (!consumed) {
      const markdown = buildFileMentionMarkdown(value, name, kind);
      const mention: ComposerMentionPrefill = {
        id: `ide-file:${ref.path}`,
        category: "files" as const,
        label: name,
        value,
        markdown,
        data: { kind, path: normalizeForCompare(ref.path), relativePath: relative ?? undefined },
      };
      useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(
          workspacePath,
          markdown,
          workspace.identity,
          mention,
          "prepend-if-missing",
        );
    }
    await nextFrame();
  }
}

/**
 * 编辑器选区：转发到官方「代码评论加入对话」事件（代码预览选区评论同款）。
 *
 * composer 把它作为上下文附件挂在输入框上方（可单独删除），不覆盖已有正文；
 * 发送时官方序列化为 `# Code comments:` 块（File/Lines/Selected text/Comment）。
 * 维持 2026-10-24 的设计：只发路径与行号，`selectedText`/`comment` 传空串，
 * 模型按 File+Lines 自己读文件，避免大段代码重复塞进 prompt。
 *
 * composer 只在面板聚焦时监听；未被消费（面板未聚焦）时回退到既有 store 请求
 * （维持旧的 setText 语义），宁可覆盖草稿也不静默丢消息。
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
    const name = fullPath.split("/").pop() || fullPath;
    const payload: CodeCommentPayload = {
      workspacePath,
      ...(workspace.identity ? { workspaceIdentity: workspace.identity } : {}),
      sourcePath: fullPath,
      sourceTitle: name,
      selectedText: "",
      comment: "",
      startLine,
      endLine,
    };
    const consumed = !window.dispatchEvent(
      new CustomEvent(CODE_COMMENT_ADD_TO_CHAT_EVENT, {
        cancelable: true,
        detail: payload,
      }),
    );
    if (!consumed) {
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
    }
    await nextFrame();
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 80));
}
