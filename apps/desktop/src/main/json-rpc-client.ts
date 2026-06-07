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

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

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

  call<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<T> {
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

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.disposed) {
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
      );
    }
  }

  dispose(): void {
    this.disposed = true;
    this.rejectAll(new Error("JSON-RPC client disposed"));
  }

  private handleLine(line: string): void {
    let response: JsonRpcResponse;

    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.rejectAll(new Error("Python Worker wrote invalid JSON to stdout"));
      return;
    }

    if (response.jsonrpc !== "2.0" || typeof response.id !== "string") {
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(
        new JsonRpcRemoteError(
          response.error.code,
          response.error.message,
          response.error.data,
        ),
      );
      return;
    }

    pending.resolve(response.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
