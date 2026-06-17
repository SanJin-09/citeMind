import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonRpcClient, JsonRpcRemoteError } from "../src/main/json-rpc-client";

function createFakeChild(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
}

function nextRequest(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve) =>
    child.stdin.once("data", (data) => resolve(String(data))),
  );
}

function writeResponse(
  child: ChildProcessWithoutNullStreams,
  response: string,
): void {
  (child.stdout as PassThrough).write(`${response}\n`);
}

describe("JsonRpcClient", () => {
  it("matches successful responses to requests", async () => {
    const child = createFakeChild();
    const client = new JsonRpcClient(child);
    const requestLine = nextRequest(child);
    const resultPromise = client.call<{ status: string }>("system.health");
    const request = JSON.parse(await requestLine) as { id: string };

    writeResponse(
      child,
      `{"jsonrpc":"2.0","id":"${request.id}","result":{"status":"ok"}}`,
    );

    await expect(resultPromise).resolves.toEqual({ status: "ok" });
  });

  it("exposes remote error codes", async () => {
    const child = createFakeChild();
    const client = new JsonRpcClient(child);
    const requestLine = nextRequest(child);
    const resultPromise = client.call("missing.method");
    const request = JSON.parse(await requestLine) as { id: string };

    writeResponse(
      child,
      `{"jsonrpc":"2.0","id":"${request.id}","error":{"code":-32601,"message":"Method not found"}}`,
    );

    await expect(resultPromise).rejects.toMatchObject({
      code: -32601,
      message: "Method not found",
    } satisfies Partial<JsonRpcRemoteError>);
  });

  it("times out unanswered requests", async () => {
    const child = createFakeChild();
    const client = new JsonRpcClient(child);

    await expect(client.call("slow.method", {}, 5)).rejects.toThrow(
      "JSON-RPC request timed out: slow.method",
    );
  });

  it("sends notifications without an id", async () => {
    const child = createFakeChild();
    const client = new JsonRpcClient(child);
    const requestLine = nextRequest(child);

    client.notify("jobs.progress", { progress: 50 });

    await expect(requestLine).resolves.toBe(
      '{"jsonrpc":"2.0","method":"jobs.progress","params":{"progress":50}}\n',
    );
  });

  it("dispatches server notifications without resolving a request", async () => {
    const child = createFakeChild();
    const client = new JsonRpcClient(child);
    const received: unknown[] = [];
    client.onNotification("agent_runs.trace_event", (params) => {
      received.push(params);
    });
    const requestLine = nextRequest(child);
    const resultPromise = client.call<{ status: string }>("system.health");
    const request = JSON.parse(await requestLine) as { id: string };

    writeResponse(
      child,
      '{"jsonrpc":"2.0","method":"agent_runs.trace_event","params":{"runId":"run-1","sequence":1}}',
    );
    writeResponse(
      child,
      `{"jsonrpc":"2.0","id":"${request.id}","result":{"status":"ok"}}`,
    );

    await expect(resultPromise).resolves.toEqual({ status: "ok" });
    expect(received).toEqual([{ runId: "run-1", sequence: 1 }]);
  });
});
