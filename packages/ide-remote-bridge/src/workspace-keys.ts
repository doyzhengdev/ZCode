/**
 * 工作区 key 的统一判定点。
 *
 * server 的 `resolveWorkspaceKey` 是**字面字符串**（`workspaceIdentity || workspacePath`），
 * 同一个目录换个写法就会被当成两个工作区、各派生一个 agent。IDE 面板使用的是
 * `projectService` 里的原始 `rootPath`（Windows 下是反斜杠），因此：
 *
 * - 下发给手机、回给 bridge 的 key 一律保持 server 原始写法；
 * - 只在**比较**时归一化（正/反斜杠、大小写、尾斜杠），用于容错匹配手机回传的写法。
 */

/** 归一化只用于比较，不能作为 key 下发。 */
export function normalizeWorkspaceKey(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export interface WorkspaceKeyTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** 手机端可能用 identity、正斜杠路径或反斜杠路径作 workspaceKey。 */
export function workspaceKeyMatches(
  target: WorkspaceKeyTarget,
  requestedKey: string,
): boolean {
  const normalized = normalizeWorkspaceKey(requestedKey);
  return [target.workspaceIdentity, target.workspacePath]
    .filter((candidate): candidate is string => Boolean(candidate?.trim()))
    .some((candidate) => normalizeWorkspaceKey(candidate) === normalized);
}

/** 按归一化结果去重，保留第一次出现的原始写法。 */
export function dedupeWorkspacePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path) continue;
    const key = normalizeWorkspaceKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
}

/**
 * 找到手机请求的工作区，返回列表项（调用方用它的 `workspacePath` 当 key，
 * 不要回声请求原值）。未指定 key 时取第一项。
 */
export function resolveWorkspaceTarget<T extends WorkspaceKeyTarget>(
  targets: readonly T[],
  requestedKey?: string,
): T | undefined {
  const key = requestedKey?.trim();
  return key ? targets.find((target) => workspaceKeyMatches(target, key)) : targets[0];
}
