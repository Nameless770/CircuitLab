import { randomUUID } from "node:crypto";
import type { UserRecord, UserSummary } from "@circuitlab/api-contract";
import { Injectable } from "@nestjs/common";
import { UsersRepository, type NewUser, type UserWithPassword } from "../auth/users.repository";
import { Clock } from "../common/clock";

/** Accounts in a Map, for when there is no database. One account per email address, as in PostgreSQL. */
@Injectable()
export class InMemoryUsersRepository extends UsersRepository {
  private readonly byId = new Map<string, UserWithPassword>();
  private readonly idByEmail = new Map<string, string>();

  constructor(private readonly clock: Clock) {
    super();
  }

  async create(user: NewUser): Promise<UserRecord | undefined> {
    if (this.idByEmail.has(user.email)) return undefined;
    const stored: UserWithPassword = Object.freeze({ id: randomUUID(), ...user, createdAt: this.clock.now() });
    this.byId.set(stored.id, stored);
    this.idByEmail.set(stored.email, stored.id);
    return withoutPassword(stored);
  }

  async findByEmail(email: string): Promise<UserWithPassword | undefined> {
    const id = this.idByEmail.get(email);
    return id === undefined ? undefined : this.byId.get(id);
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    const user = this.byId.get(id);
    return user === undefined ? undefined : withoutPassword(user);
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    const user = this.byId.get(id);
    if (user !== undefined) this.byId.set(id, Object.freeze({ ...user, passwordHash }));
  }

  /** For the other in-memory repositories, which join to users like the SQL does. */
  summary(id: string): (UserSummary & { readonly email: string }) | undefined {
    const user = this.byId.get(id);
    return user === undefined ? undefined : { id: user.id, displayName: user.displayName, email: user.email };
  }
}

function withoutPassword({ id, email, displayName, createdAt }: UserWithPassword): UserRecord {
  return { id, email, displayName, createdAt };
}
