import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

const ENCRYPTED_PREFIX = "enc:v1:";

/** 读取 ~/.zcode/v2/credentials.json 的 zcode 账号 JWT（与桌面/插件共用同一份凭据）。 */
export function loadZcodeJwt(): string {
  const file = join(homedir(), ".zcode", "v2", "credentials.json");
  let store: Record<string, string>;
  try {
    store = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch (error) {
    throw new Error(`无法读取 ZCode 凭据: ${file}`, { cause: error });
  }
  const raw = store["zcodejwttoken"]?.trim();
  if (!raw) throw new Error("凭据中没有 zcodejwttoken，请先在 ZCode 中登录账号");
  if (!raw.startsWith(ENCRYPTED_PREFIX)) return raw;

  const secret =
    process.env["ZCODE_CREDENTIAL_SECRET"]?.trim() ||
    `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  const key = createHash("sha256").update(secret).digest();
  const [iv, tag, data] = raw.slice(ENCRYPTED_PREFIX.length).split(".");
  if (!iv || !tag || !data) throw new Error("zcodejwttoken 加密格式无法识别");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ])
    .toString("utf8")
    .trim();
}
