import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { KeyStore, type EncryptedData } from './keystore.js';

interface StoredKeys {
  version: number;
  keys: Record<string, {
    providerId: string;
    encryptedKey: EncryptedData;
    addedAt: string;
    lastUsed?: string;
  }>;
}

export class ProviderKeyManager {
  private keyStore: KeyStore;
  private storagePath: string;
  private data: StoredKeys | null = null;

  constructor(keyStore: KeyStore, storagePath?: string) {
    this.keyStore = keyStore;
    this.storagePath = storagePath ?? join(homedir(), '.untangle-ai', 'keys.json');
  }

  private ensureDirectory(): void {
    const dir = join(homedir(), '.untangle-ai');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private load(): StoredKeys {
    if (this.data) return this.data;

    if (!existsSync(this.storagePath)) {
      this.data = { version: 1, keys: {} };
      return this.data;
    }

    try {
      const content = readFileSync(this.storagePath, 'utf-8');
      this.data = JSON.parse(content);
      return this.data!;
    } catch {
      this.data = { version: 1, keys: {} };
      return this.data;
    }
  }

  private save(): void {
    this.ensureDirectory();
    writeFileSync(this.storagePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  async addKey(providerId: string, apiKey: string): Promise<void> {
    if (!this.keyStore.isInitialized()) {
      throw new Error('KeyStore not initialized');
    }

    const data = this.load();
    const encrypted = await this.keyStore.encrypt(apiKey);

    data.keys[providerId] = {
      providerId,
      encryptedKey: encrypted,
      addedAt: new Date().toISOString(),
    };

    this.save();
  }

  async getKey(providerId: string): Promise<string | null> {
    if (!this.keyStore.isInitialized()) {
      throw new Error('KeyStore not initialized');
    }

    const data = this.load();
    const entry = data.keys[providerId];

    if (!entry) return null;

    // Update last used
    entry.lastUsed = new Date().toISOString();
    this.save();

    return this.keyStore.decrypt(entry.encryptedKey);
  }

  removeKey(providerId: string): boolean {
    const data = this.load();
    if (!data.keys[providerId]) return false;

    delete data.keys[providerId];
    this.save();
    return true;
  }

  listProviders(): Array<{ providerId: string; addedAt: string; lastUsed?: string }> {
    const data = this.load();
    return Object.values(data.keys).map(({ providerId, addedAt, lastUsed }) => ({
      providerId,
      addedAt,
      lastUsed,
    }));
  }

  hasKey(providerId: string): boolean {
    const data = this.load();
    return !!data.keys[providerId];
  }
}
