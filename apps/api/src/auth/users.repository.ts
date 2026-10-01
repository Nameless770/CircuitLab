import type { UserRecord } from "@circuitlab/api-contract";

export interface NewUser {
  /** Already normalized (lower case). */
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
}

/** An account together with its password hash: only signing in ever needs the hash. */
export interface UserWithPassword extends UserRecord {
  readonly passwordHash: string;
}

/** Accounts. Bound by StorageModule, like every repository: PostgreSQL or memory. */
export abstract class UsersRepository {
  /** The new account, or undefined if the email address is taken. */
  abstract create(user: NewUser): Promise<UserRecord | undefined>;

  abstract findByEmail(email: string): Promise<UserWithPassword | undefined>;

  abstract findById(id: string): Promise<UserRecord | undefined>;

  abstract updatePasswordHash(id: string, passwordHash: string): Promise<void>;
}
