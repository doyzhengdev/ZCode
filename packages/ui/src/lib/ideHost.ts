/**
 * 是否运行在 ZCode IDE 插件的 JCEF 宿主里。
 *
 * 插件加载 webview 时会在 URL 上追加 `ideHost=1`。桌面端和独立 web 端没有该参数，
 * 因此侧栏与头部的精简只作用于 IDE 内嵌形态，官方桌面端的入口保持原样。
 */
export function isIdeHost(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("ideHost") === "1";
}
