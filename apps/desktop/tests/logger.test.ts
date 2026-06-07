import { describe, expect, it } from "vitest";
import { redactLogText } from "../src/main/logger";

describe("redactLogText", () => {
  it("redacts Ark and API key values", () => {
    expect(redactLogText("ark_api_key=secret-value")).toBe(
      "ark_api_key=[REDACTED]",
    );
    expect(redactLogText("api-key: another-secret")).toBe(
      "api-key: [REDACTED]",
    );
  });

  it("redacts bearer credentials", () => {
    expect(redactLogText("Authorization: Bearer secret-token")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });
});
