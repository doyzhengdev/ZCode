/**
 * JCEF ⇄ Web UI 的请求/响应通道。
 *
 * 插件侧注入 `window.__ZCODE_IDE_QUERY__(json)`（由 JBCefJSQuery 包装），
 * 收到 `{id, method, params}` 后转给 Java；Java 处理完调用
 * `window.__zcodeIdeResolve(id, ok, payload)` 回填 Promise。
 *
 * 纯浏览器开发模式（没有 JCEF）下走 dev 兜底，便于脱离 IDE 调 UI。
 */

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

declare global {
  interface Window {
    /** 插件注入：把 JSON 请求送到 Java。 */
    __ZCODE_IDE_QUERY__?: (json: string) => void;
    /** 插件调用：回填结果。 */
    __zcodeIdeResolve?: (id: number, ok: boolean, payload: string) => void;
  }
}

const pending = new Map<number, PendingCall>();
let seq = 1;
let devWorkspace: string | null = null;

export function installIdeBridge(): void {
  const params = new URLSearchParams(window.location.search);
  devWorkspace = params.get("ideWorkspace");

  window.__zcodeIdeResolve = (id, ok, payload) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    if (!ok) {
      call.reject(new Error(payload || "IDE bridge request failed"));
      return;
    }
    try {
      call.resolve(payload ? JSON.parse(payload) : undefined);
    } catch (error) {
      call.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

export function hasIdeBridge(): boolean {
  return typeof window.__ZCODE_IDE_QUERY__ === "function";
}

export function invoke<T>(method: string, params?: unknown): Promise<T> {
  if (!hasIdeBridge()) {
    return devInvoke<T>(method, params);
  }
  const id = seq++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    try {
      window.__ZCODE_IDE_QUERY__!(JSON.stringify({ id, method, params: params ?? null }));
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** 没有 JCEF 时的最小兜底：目录选择返回 URL 参数里的 ideWorkspace。 */
async function devInvoke<T>(method: string, params?: unknown): Promise<T> {
  switch (method) {
    case "selectDirectory":
      return (devWorkspace ?? null) as T;
    case "selectDirectories":
      return (devWorkspace ? [devWorkspace] : []) as T;
    case "selectFile":
      return null as T;
    case "selectFiles":
      return [] as T;
    case "openExternal": {
      const url = (params as { url?: string } | undefined)?.url;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      return undefined as T;
    }
    default:
      return undefined as T;
  }
}
