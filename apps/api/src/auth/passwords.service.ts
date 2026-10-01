import { randomBytes } from "node:crypto";
import { normalizePassword } from "@circuitlab/api-contract";
import { Injectable } from "@nestjs/common";
import { argon2id, hash, needsRehash, verify } from "argon2";

/**
 * Argon2id with OWASP's recommended minimum: 19 MiB of memory, 2 passes, 1 lane. The memory is
 * what makes guessing expensive on graphics cards. Hashing takes some tens of milliseconds on the
 * libuv thread pool, not on the event loop. The parameters are stored in each hash, so raising
 * them later re-hashes each password at its owner's next sign-in (needsRehash).
 */
const OPTIONS = { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordsService {
  /**
   * Checked against when an email address has no account, so that a sign-in takes as long whether
   * or not the account exists, and response times don't reveal which addresses have accounts.
   */
  private readonly decoy: Promise<string> = hash(randomBytes(32).toString("base64"), OPTIONS);

  hash(password: string): Promise<string> {
    return hash(normalizePassword(password), OPTIONS);
  }

  /** Whether `password` matches `storedHash`; with no stored hash, does the same work and says no. */
  async verify(storedHash: string | undefined, password: string): Promise<boolean> {
    const matches = await verify(storedHash ?? (await this.decoy), normalizePassword(password));
    return matches && storedHash !== undefined;
  }

  needsRehash(storedHash: string): boolean {
    return needsRehash(storedHash, OPTIONS);
  }
}
