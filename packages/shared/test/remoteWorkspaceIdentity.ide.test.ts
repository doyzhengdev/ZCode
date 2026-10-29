// IDE 插件侧补充用例：Windows 盘符路径在 identity 里的 "/E:/x" 形态（解析还原、build(parse)
// 恒等、hostId 裁剪）。用例随 IDE 补丁迁移到独立文件（官方测试文件保持上游原状）。
import { describe, expect, it } from "vitest";
import {
  buildServerRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "../src/remote-workspace-identity.js";

describe("parseRemoteWorkspaceIdentity (IDE Windows drive form)", () => {
  it("Windows 盘符路径：identity 存 /E:/x 形态，解析还原为 E:/x", () => {
    expect(parseRemoteWorkspaceIdentity("remote:server:zdy-pc:/E:/gitee/ezllm")).toEqual({
      kind: "server",
      sourceServerId: "zdy-pc",
      workspacePath: "E:/gitee/ezllm",
    });
    // 盘根 /C: 还原为 C:
    expect(parseRemoteWorkspaceIdentity("remote:server:s:/C:")).toEqual({
      kind: "server",
      sourceServerId: "s",
      workspacePath: "C:",
    });
  });

  it("Windows 盘符路径 build(parse(identity)) 恒等，hostId 裁剪不漂移", () => {
    const identity = buildServerRemoteWorkspaceIdentity({
      serverId: "ZDY-PC",
      workspacePath: "E:\\gitee\\ezllm",
    });
    expect(identity).toBe("remote:server:zdy-pc:/E:/gitee/ezllm");
    const parsed = parseRemoteWorkspaceIdentity(identity)!;
    expect(
      buildServerRemoteWorkspaceIdentity({
        serverId: parsed.sourceServerId!,
        workspacePath: parsed.workspacePath,
      }),
    ).toBe(identity);
    expect(remoteHostIdFromWorkspaceIdentity(identity)).toBe("remote:server:zdy-pc");
    expect(remoteHostIdFromWorkspaceIdentity("remote:wsl:Debian:/home/dev")).toBe(
      "remote:wsl:Debian",
    );
  });
});
