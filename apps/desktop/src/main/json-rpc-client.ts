import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: JsonRpcErrorPayload;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

type NotificationListener = (params: unknown) => void;

export class JsonRpcRemoteError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcRemoteError";
  }
}

export class JsonRpcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationListeners = new Map<
    string,
    Set<NotificationListener>
  >();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.once("error", (error) => this.rejectAll(error));
    child.once("exit", (code, signal) => {
      this.rejectAll(
        new Error(`Python Worker exited (code=${code}, signal=${signal})`),
      );
    });
  }

  call<T>(method: string, params: object = {}, timeoutMs = 10_000): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("JSON-RPC client is disposed"));
    }

    const id = String(this.nextId++);
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.child.stdin.write(`${request}\n`);
    });
  }

  notify(method: string, params: object = {}): void {
    if (!this.disposed) {
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
      );
    }
  }

  onNotification(method: string, listener: NotificationListener): () => void {
    const listeners = this.notificationListeners.get(method) ?? new Set();
    listeners.add(listener);
    this.notificationListeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.notificationListeners.delete(method);
      }
    };
  }

  dispose(): void {
    this.disposed = true;
    this.rejectAll(new Error("JSON-RPC client disposed"));
  }

  private handleLine(line: string): void {
    let response: JsonRpcResponse | JsonRpcNotification;

    try {
      response = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
    } catch {
      this.rejectAll(new Error("Python Worker wrote invalid JSON to stdout"));
      return;
    }

    if (
      response.jsonrpc === "2.0" &&
      "method" in response &&
      typeof response.method === "string" &&
      !("id" in response)
    ) {
      this.handleNotification(response.method, response.params);
      return;
    }

    if (
      response.jsonrpc !== "2.0" ||
      !("id" in response) ||
      typeof response.id !== "string"
    ) {
      return;
    }

    const rpcResponse = response;
    const pending = this.pending.get(rpcResponse.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(rpcResponse.id);

    if (rpcResponse.error) {
      pending.reject(
        new JsonRpcRemoteError(
          rpcResponse.error.code,
          rpcResponse.error.message,
          rpcResponse.error.data,
        ),
      );
      return;
    }

    pending.resolve(rpcResponse.result);
  }

  private handleNotification(method: string, params: unknown): void {
    const listeners = this.notificationListeners.get(method);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(params);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
