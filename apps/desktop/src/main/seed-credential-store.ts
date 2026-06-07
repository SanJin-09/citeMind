import { app, safeStorage } from "electron";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SEED_DEFAULTS } from "../shared/contracts";

interface StoredSeedCredential {
  id: string;
  name: string;
  encryptedKeyBase64: string;
  encryptedKeyRef: string;
  maskedKey: string;
  baseUrl: string;
  defaultChatModel: string;
  defaultEmbeddingModel: string;
  createdAt: string;
  updatedAt: string;
}

export interface SeedCredentialSummary {
  configured: boolean;
  safeStorageAvailable: boolean;
  id: string;
  name?: string;
  maskedKey?: string;
  baseUrl: string;
  encryptedKeyRef: string;
  defaultChatModel: string;
  defaultEmbeddingModel: string;
  updatedAt?: string;
}

export class SeedCredentialStore {
  async summary(): Promise<SeedCredentialSummary> {
    const record = await this.readRecord();
    if (!record) {
      return this.emptySummary();
    }
    return {
      configured: true,
      safeStorageAvailable: safeStorage.isEncryptionAvailable(),
      id: record.id,
      name: record.name,
      maskedKey: record.maskedKey,
      baseUrl: record.baseUrl,
      encryptedKeyRef: record.encryptedKeyRef,
      defaultChatModel: record.defaultChatModel,
      defaultEmbeddingModel: record.defaultEmbeddingModel,
      updatedAt: record.updatedAt,
    };
  }

  async save(input: {
    name: string;
    apiKey: string;
    defaultChatModel?: string;
    defaultEmbeddingModel?: string;
  }): Promise<SeedCredentialSummary> {
    this.assertSafeStorage();
    const now = new Date().toISOString();
    const existing = await this.readRecord();
    const apiKey = input.apiKey.trim();
    if (!apiKey) {
      throw new Error("Ark API Key 不能为空");
    }

    const encrypted = safeStorage.encryptString(apiKey);
    const record: StoredSeedCredential = {
      id: SEED_DEFAULTS.credentialId,
      name: input.name.trim() || "我的 Seed API",
      encryptedKeyBase64: encrypted.toString("base64"),
      encryptedKeyRef: SEED_DEFAULTS.encryptedKeyRef,
      maskedKey: maskArkApiKey(apiKey),
      baseUrl: SEED_DEFAULTS.baseUrl,
      defaultChatModel:
        input.defaultChatModel ?? SEED_DEFAULTS.defaultChatModel,
      defaultEmbeddingModel:
        input.defaultEmbeddingModel ?? SEED_DEFAULTS.defaultEmbeddingModel,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(record, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    return this.summary();
  }

  async readApiKey(): Promise<string> {
    this.assertSafeStorage();
    const record = await this.readRecord();
    if (!record) {
      throw new Error("尚未配置 Ark API Key");
    }
    return safeStorage.decryptString(
      Buffer.from(record.encryptedKeyBase64, "base64"),
    );
  }

  async delete(): Promise<SeedCredentialSummary> {
    await rm(this.filePath, { force: true });
    return this.emptySummary();
  }

  private async readRecord(): Promise<StoredSeedCredential | undefined> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as StoredSeedCredential;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  private emptySummary(): SeedCredentialSummary {
    return {
      configured: false,
      safeStorageAvailable: safeStorage.isEncryptionAvailable(),
      id: SEED_DEFAULTS.credentialId,
      baseUrl: SEED_DEFAULTS.baseUrl,
      encryptedKeyRef: SEED_DEFAULTS.encryptedKeyRef,
      defaultChatModel: SEED_DEFAULTS.defaultChatModel,
      defaultEmbeddingModel: SEED_DEFAULTS.defaultEmbeddingModel,
    };
  }

  private assertSafeStorage(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "当前系统不可用 Electron safeStorage，无法安全保存 Ark API Key",
      );
    }
  }

  private get filePath(): string {
    return path.join(
      app.getPath("userData"),
      "credentials",
      "seed-api-key.json",
    );
  }
}

export function maskArkApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return "";
  }
  const suffix = trimmed.slice(-4);
  return `****${suffix}`;
}
