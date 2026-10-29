import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeWorkspacePaths,
  normalizeWorkspaceKey,
  resolveWorkspaceTarget,
  workspaceKeyMatches,
} from "../src/workspace-keys.ts";

test("手机回传正斜杠路径能匹配 server 的反斜杠写法", () => {
  const target = { workspacePath: "E:\\work\\zcode-ide" };
  assert.equal(workspaceKeyMatches(target, "E:/work/zcode-ide"), true);
  assert.equal(workspaceKeyMatches(target, "e:/WORK/zcode-ide/"), true);
  assert.equal(workspaceKeyMatches(target, "E:/work/other"), false);
});

test("identity 仍可作为 workspaceKey 匹配", () => {
  const target = {
    workspacePath: "E:\\work\\zcode-ide",
    workspaceIdentity: "remote:server:host-a:/e:/work/zcode-ide",
  };
  assert.equal(
    workspaceKeyMatches(target, "remote:server:host-a:/E:/work/zcode-ide"),
    true,
  );
});

test("解析请求时返回列表项本身，调用方拿到 server 原始写法", () => {
  const targets = [
    { workspacePath: "E:\\work\\zcode-ide" },
    { workspacePath: "E:\\work\\example-project" },
  ];
  assert.equal(
    resolveWorkspaceTarget(targets, "E:/work/zcode-ide")?.workspacePath,
    "E:\\work\\zcode-ide",
  );
  assert.equal(resolveWorkspaceTarget(targets, "e:\\WORK\\example-project\\")?.workspacePath, "E:\\work\\example-project");
  assert.equal(resolveWorkspaceTarget(targets, "E:/work/nope"), undefined);
  assert.equal(resolveWorkspaceTarget(targets)?.workspacePath, "E:\\work\\zcode-ide");
});

test("去重按归一化结果判断，但保留第一次出现的原始写法", () => {
  assert.deepEqual(
    dedupeWorkspacePaths(["E:\\a\\b", "E:/a/b/", "E:\\a\\c", "  ", "e:\\A\\B"]),
    ["E:\\a\\b", "E:\\a\\c"],
  );
});

test("归一化只影响比较，不改变下发值", () => {
  assert.equal(normalizeWorkspaceKey("E:\\work\\zcode-ide\\"), "e:/work/zcode-ide");
});
