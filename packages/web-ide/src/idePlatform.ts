/**
 * IDE 版 IPlatformService。
 *
 * 形状对齐 packages/desktop 的 desktopPlatform：桌面端把能力委托给 preload 的
 * `window.zcode`，这里改为委托给 JCEF 桥。Web 端不支持的本机文件能力在 IDE 里全部打开，
 * 远程工作区 / Docker / WSL / CUA / 内置浏览器等仍保持"不支持"。
 */
import type {
  IPlatformService,
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MaterializeWorkflowArtifactFileRequest,
  MaterializeWorkflowArtifactFileResult,
  SaveCliMcpToUserDirectoryRequest,
  SaveFileResult,
  WebRemoteControlContext,
  WebRemoteControlStatus,
} from "@zcode/shared";
import { invoke } from "./ideBridge.js";

const notSupported = (what: string) => Promise.resolve({ success: false, error: `${what} 在 IDE 宿主中不支持` });

/** 与桌面端 `desktopSaveFile.ts` / `workflowArtifactFile.ts` 的上限保持一致。 */
const MAX_SAVE_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function toUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/**
 * 另存为：桥只能传 JSON，`ArrayBuffer` 直接过 JSON 会变成 `{}`，所以这里先转 base64。
 * 桌面端由 main 进程下载 `sourceUrl`；JCEF 里只能在页面 fetch，跨域失败按下载失败处理。
 */
async function saveFileToHost(payload: unknown): Promise<SaveFileResult> {
  const request = (payload ?? {}) as {
    suggestedName?: unknown;
    data?: unknown;
    sourceUrl?: unknown;
  };
  const suggestedName =
    typeof request.suggestedName === "string" ? request.suggestedName.trim() : "";
  if (!suggestedName) return { success: false, error: "invalid_file_payload" };

  let bytes = toUint8Array(request.data);
  if (!bytes && typeof request.sourceUrl === "string") {
    try {
      const response = await fetch(request.sourceUrl);
      if (!response.ok) return { success: false, error: "download_failed" };
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      return { success: false, error: "download_failed" };
    }
  }
  if (!bytes || bytes.byteLength === 0) {
    return { success: false, error: "invalid_file_payload" };
  }
  if (bytes.byteLength > MAX_SAVE_FILE_BYTES) {
    return { success: false, error: "file_too_large" };
  }
  return invoke<SaveFileResult>("saveFile", {
    suggestedName,
    dataBase64: bytesToBase64(bytes),
  });
}

/** dwf 产物「作为文件打开」：字节同样以 base64 过桥，由 Kotlin 落成本机副本。 */
async function materializeArtifactFile(
  payload: unknown,
): Promise<MaterializeWorkflowArtifactFileResult> {
  const request = (payload ?? {}) as Partial<MaterializeWorkflowArtifactFileRequest>;
  const bytes = toUint8Array(request.bytes);
  if (!bytes || bytes.byteLength === 0) throw new Error("artifact bytes are not loaded");
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error("artifact is too large to open as a file");
  }
  const result = await invoke<MaterializeWorkflowArtifactFileResult | null>(
    "materializeWorkflowArtifactFile",
    {
      runId: request.runId,
      artifactId: request.artifactId,
      version: request.version,
      fileName: request.fileName,
      bytesBase64: bytesToBase64(bytes),
    },
  );
  if (!result?.localPath) throw new Error("materialize artifact failed");
  return result;
}

/**
 * MCP 用户目录读写：桌面端由 Electron 主进程实现，IDE 里宿主就是本机 zcode-server，
 * 直接转发到它的 mcpSyncService（读写同一个 ~/.zcode/cli/config.json）。
 */
interface McpDirectoryBridge {
  loadMcpFromUserDirectory?: (
    payload?: LoadCliMcpFromUserDirectoryRequest,
  ) => Promise<LoadCliMcpFromUserDirectoryResult>;
  saveMcpToUserDirectory?: (payload: SaveCliMcpToUserDirectoryRequest) => Promise<void>;
}

export interface IdePlatformServices {
  mcpSyncService?: McpDirectoryBridge;
}

export function createIdePlatform(services?: IdePlatformServices): IPlatformService {
  const platform = {
    canSelectFilePath: true,
    canOpenLocalFiles: true,

    // ---- 本机文件能力：交给 IDE ----
    selectDirectory: () => invoke<string | null>("selectDirectory"),
    selectDirectories: () => invoke<string[]>("selectDirectories"),
    selectFile: () => invoke<string | null>("selectFile"),
    selectFiles: () => invoke<string[]>("selectFiles"),
    saveFile: (payload: unknown) => saveFileToHost(payload),
    createTempTextAttachment: (payload: unknown) => invoke("createTempTextAttachment", payload),
    materializeWorkflowArtifactFile: (payload: unknown) => materializeArtifactFile(payload),
    openExternal: (url: string) => {
      void invoke("openExternal", { url });
    },
    openInFileManager: (path: string) => invoke("openInFileManager", { path }),
    openExternalFile: (path: string, location?: { line?: number; column?: number }) =>
      invoke("openExternalFile", { path, ...location }),
    selectInProjectView: (path: string) => invoke("selectInProjectView", { path }),

    // ---- 通知 ----
    showTaskNotification: (payload: unknown) => {
      void invoke("showTaskNotification", payload);
    },

    // ---- 远程工作区 / 容器：IDE 不做；Web 远控由插件进程桥接 ----
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    onRemoteSessionReconnected: () => () => {},
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    connectRemote: () => Promise.resolve({ success: false, error: "remote_not_supported" }),
    requestSourceSettingsAttachment: () => Promise.reject(new Error("remote_not_supported")),
    cancelPendingRemoteConnection: () => Promise.resolve(),
    bindRemoteWorkspaceSessionContext: () => Promise.reject(new Error("remote_not_supported")),
    startWebRemoteControl: async (context: WebRemoteControlContext) => {
      const result = await invoke<{
        sessionId: string;
        windowControlSessionId?: string;
        qrUrl: string;
        connectUrl: string;
        workspacePath: string;
        workspaceIdentity?: string;
      }>("startWebRemoteControl", {
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      });
      return {
        status: "running",
        sessionId: result.sessionId,
        windowControlSessionId: result.windowControlSessionId,
        qrUrl: result.qrUrl,
        connectUrl: result.connectUrl,
        workspacePath: result.workspacePath,
        ...(result.workspaceIdentity ? { workspaceIdentity: result.workspaceIdentity } : {}),
        ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
        ...(context.initialTaskId ? { initialTaskId: context.initialTaskId } : {}),
      };
    },
    stopWebRemoteControl: async () => {
      await invoke("stopWebRemoteControl", {});
    },
    getWebRemoteControlStatus: async () => {
      const status = await invoke<WebRemoteControlStatus | undefined>(
        "getWebRemoteControlStatus",
        {},
      );
      return status ?? { status: "idle" };
    },
    onWebRemoteControlStatusChanged: () => () => {},
    disposeRemoteSession: () => Promise.resolve(),
    notifyWebRemoteControlAuthStateChanged: () => {},
    isDockerAvailable: () => Promise.resolve(false),
    listWSLDistros: () => Promise.resolve([]),
    listDockerContainers: () => Promise.resolve([]),
    listSSHConfigAliases: () => Promise.resolve([]),
    // 宿主侧 MCP 配置目录：转发给本机 zcode-server，不能返回空 stub——
    // MCP store 对本地 workspace 固定走 platform 分支，「已安装」列表直接读它。
    loadMcpFromUserDirectory: (payload?: LoadCliMcpFromUserDirectoryRequest) =>
      services?.mcpSyncService?.loadMcpFromUserDirectory
        ? services.mcpSyncService.loadMcpFromUserDirectory(payload)
        : Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: async (payload: SaveCliMcpToUserDirectoryRequest) => {
      const bridge = services?.mcpSyncService;
      if (!bridge?.saveMcpToUserDirectory) {
        return { success: false, error: "MCP 目录管理在 IDE 宿主中不可用" };
      }
      try {
        await bridge.saveMcpToUserDirectory(payload);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    migrateLegacyCommonMcp: () =>
      Promise.resolve({ servers: {}, totalCount: 0, importedCount: 0, skippedCount: 0 }),

    // ---- 平台杂项 ----
    openFeedback: () => Promise.resolve(),
    openCommunity: () => Promise.resolve(),
    canOpenCommunity: () => Promise.resolve(false),
    registerOAuthState: () => {},
    onOAuthCallback: () => () => {},
    onPaymentCallback: () => () => {},
    onShareImport: () => () => {},
    notifyRendererReady: () => {},
    reportTelemetryEvent: () => Promise.resolve(),
    reportArmsCustomEvent: () => Promise.resolve(),
    syncWindowTabs: () => {},
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    onFocusTab: () => () => {},
    onNewTab: () => () => {},
    onCloseActiveContextRequest: () => () => {},
    onOpenBrowserUrl: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onWindowFullscreenChanged: () => () => {},
    onTaskNotificationClick: () => () => {},

    // ---- 更新 / 日志 / 截图：IDE 侧暂不提供 ----
    exportLogs: () => notSupported("导出日志"),
    captureWindowScreenshot: () => Promise.resolve(null),
    importChromeBrowserData: () =>
      Promise.resolve({
        success: false,
        cookies: { imported: 0, skipped: 0, failed: 0 },
        localStorage: {
          originsImported: 0,
          entriesImported: 0,
          originsSkipped: 0,
          originsFailed: 0,
        },
        error: "chrome_import_not_supported",
      }),
    clearEmbeddedBrowserData: () => notSupported("内置浏览器"),
    onUpdateReady: () => () => {},
    onUpdateCheckResult: () => () => {},
    onUpdateStateChanged: () => () => {},
    getUpdateState: () => Promise.resolve({ kind: "idle", enabled: false }),
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    onPostUpdateReleaseNotes: () => () => {},
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),
    getInstalledEditors: () => Promise.resolve([]),
    // IDE 本身就是编辑器：系统文件管理器别名走资源管理器，目录交给项目树，
    // 其余编辑器 id 一律由 IDE 编辑器打开。
    openInEditor: (editorId: string, path: string, options?: { pathKind?: string }) =>
      editorId === "explorer" || editorId === "finder" || options?.pathKind === "directory"
        ? invoke("openInFileManager", { path })
        : invoke("openExternalFile", { path }),
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: () => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),
    getDeviceId: () => "zcode-ide",
  };

  // 未显式实现的可选能力保持缺席（undefined），UI 会自动隐藏对应入口。
  return new Proxy(platform as unknown as IPlatformService, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      return undefined;
    },
  });
}
