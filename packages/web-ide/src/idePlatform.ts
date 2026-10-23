/**
 * IDE 版 IPlatformService。
 *
 * 形状对齐 packages/desktop 的 desktopPlatform：桌面端把能力委托给 preload 的
 * `window.zcode`，这里改为委托给 JCEF 桥。Web 端不支持的本机文件能力在 IDE 里全部打开，
 * 远程工作区 / Docker / WSL / CUA / 内置浏览器等仍保持"不支持"。
 */
import type { IPlatformService } from "@zcode/shared";
import { invoke } from "./ideBridge.js";

const notSupported = (what: string) => Promise.resolve({ success: false, error: `${what} 在 IDE 宿主中不支持` });

export function createIdePlatform(): IPlatformService {
  const platform = {
    canSelectFilePath: true,
    canOpenLocalFiles: true,

    // ---- 本机文件能力：交给 IDE ----
    selectDirectory: () => invoke<string | null>("selectDirectory"),
    selectDirectories: () => invoke<string[]>("selectDirectories"),
    selectFile: () => invoke<string | null>("selectFile"),
    selectFiles: () => invoke<string[]>("selectFiles"),
    saveFile: (payload: unknown) => invoke("saveFile", payload),
    createTempTextAttachment: (payload: unknown) => invoke("createTempTextAttachment", payload),
    materializeWorkflowArtifactFile: (payload: unknown) =>
      invoke("materializeWorkflowArtifactFile", payload),
    openExternal: (url: string) => {
      void invoke("openExternal", { url });
    },
    openInFileManager: (path: string) => invoke("openInFileManager", { path }),
    openExternalFile: (path: string) => invoke("openExternalFile", { path }),

    // ---- 通知 ----
    showTaskNotification: (payload: unknown) => {
      void invoke("showTaskNotification", payload);
    },

    // ---- 远程 / 多窗口 / 容器：IDE 首期不做 ----
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    onRemoteSessionReconnected: () => () => {},
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    connectRemote: () => Promise.resolve({ success: false, error: "remote_not_supported" }),
    requestSourceSettingsAttachment: () => Promise.reject(new Error("remote_not_supported")),
    cancelPendingRemoteConnection: () => Promise.resolve(),
    bindRemoteWorkspaceSessionContext: () => Promise.reject(new Error("remote_not_supported")),
    startWebRemoteControl: () => Promise.reject(new Error("web_remote_control_not_supported")),
    stopWebRemoteControl: () => Promise.resolve(),
    getWebRemoteControlStatus: () => Promise.resolve({ status: "idle" }),
    onWebRemoteControlStatusChanged: () => () => {},
    disposeRemoteSession: () => Promise.resolve(),
    notifyWebRemoteControlAuthStateChanged: () => {},
    isDockerAvailable: () => Promise.resolve(false),
    listWSLDistros: () => Promise.resolve([]),
    listDockerContainers: () => Promise.resolve([]),
    listSSHConfigAliases: () => Promise.resolve([]),
    loadMcpFromUserDirectory: () => Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: () => notSupported("MCP 目录管理"),
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
    openInEditor: () => notSupported("外部编辑器"),
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
