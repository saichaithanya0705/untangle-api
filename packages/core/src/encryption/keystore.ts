import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 310000;

export interface EncryptedData {
  iv: string;
  salt: string;
  authTag: string;
  ciphertext: string;
}

export class KeyStore {
  private masterKey: Buffer | null = null;

  async initialize(masterPassword: string): Promise<void> {
    // Derive master key from password using a fixed salt for this instance
    // In production, you'd store this salt securely
    const salt = crypto.createHash('sha256').update('untangle-ai-master').digest();
    this.masterKey = await this.deriveKey(masterPassword, salt);
  }

  isInitialized(): boolean {
    return this.masterKey !== null;
  }

  private deriveKey(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(
        password,
        salt,
        PBKDF2_ITERATIONS,
        KEY_LENGTH,
        'sha512',
        (err, key) => {
          if (err) reject(err);
          else resolve(key);
        }
      );
    });
  }

  async encrypt(plaintext: string): Promise<EncryptedData> {
    if (!this.masterKey) {
      throw new Error('KeyStore not initialized');
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);

    // Derive unique key for this encryption
    const derivedKey = await this.deriveKey(
      this.masterKey.toString('base64'),
      salt
    );

    const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv);

    let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
    ciphertext += cipher.final('base64');

    const authTag = cipher.getAuthTag();

    return {
      iv: iv.toString('base64'),
      salt: salt.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext,
    };
  }

  async decrypt(data: EncryptedData): Promise<string> {
    if (!this.masterKey) {
      throw new Error('KeyStore not initialized');
    }

    const iv = Buffer.from(data.iv, 'base64');
    const salt = Buffer.from(data.salt, 'base64');
    const authTag = Buffer.from(data.authTag, 'base64');

    const derivedKey = await this.deriveKey(
      this.masterKey.toString('base64'),
      salt
    );

    const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(authTag);

    let plaintext = decipher.update(data.ciphertext, 'base64', 'utf8');
    plaintext += decipher.final('utf8');

    return plaintext;
  }

  destroy(): void {
    if (this.masterKey) {
      crypto.randomFillSync(this.masterKey);
      this.masterKey = null;
    }
  }
}
