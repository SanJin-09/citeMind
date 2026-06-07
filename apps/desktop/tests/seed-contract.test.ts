import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../src/shared/contracts";

describe("Seed API IPC contract", () => {
  it("does not expose a channel for reading the raw Ark API Key", () => {
    const channels = Object.values(IPC_CHANNELS).join("\n");

    expect(channels).toContain("citemind:seed:save-credential");
    expect(channels).toContain("citemind:seed:validate-credential");
    expect(channels).not.toMatch(/read.*api.*key/i);
    expect(channels).not.toMatch(/get.*api.*key/i);
    expect(channels).not.toMatch(/decrypt/i);
  });
});
