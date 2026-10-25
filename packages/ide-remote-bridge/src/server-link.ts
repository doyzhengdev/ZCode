import WebSocket from "ws";
// 走包名而不是相对路径：tsc 按 exports 的 types 条件消费 rpc 的 dist 声明产物，
// 避免把 rpc 源码拖进本包口径重复检查（rpc 自身的 tsconfig 与 base 口径不一致）；
// esbuild 打包走 default 条件，仍然解析到同一份 src/index.ts，产物不变。
import {
  Emitter,
  SocketProtocol,
  VSBuffer,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";

function wrapNodeWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

export interface LocalServerLink {
  protocol: IMessagePassingProtocol;
  close(): void;
  closed: Promise<void>;
}

/** 以普通 terminal-client 身份连本地 server /ws，得到与手机端同构的 RPC 通道。 */
export async function connectLocalServer(wsUrl: string): Promise<LocalServerLink> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(error));
  });
  const closed = new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
  });
  const socket = wrapNodeWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  return {
    protocol,
    close: () => socket.dispose(),
    closed,
  };
}
