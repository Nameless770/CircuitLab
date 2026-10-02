import { randomUUID, timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { SessionsRepository } from "../auth/sessions.repository";

interface Session {
  readonly userId: string;
  readonly secretHash: Buffer;
  readonly expiresAt: Date;
}

/** Sessions in a Map, for when there is no database. Expired ones are dropped as new ones start. */
@Injectable()
export class InMemorySessionsRepository extends SessionsRepository {
  private readonly sessions = new Map<string, Session>();

  async create(userId: string, secretHash: Buffer, now: Date, expiresAt: Date): Promise<string> {
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
    const id = randomUUID();
    this.sessions.set(id, { userId, secretHash, expiresAt });
    return id;
  }

  /** Check and replace happen without an await in between, so no other request can interleave. */
  async rotate(sessionId: string, secretHash: Buffer, newSecretHash: Buffer, now: Date, expiresAt: Date): Promise<string | undefined> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.expiresAt <= now || !timingSafeEqual(session.secretHash, secretHash)) return undefined;
    this.sessions.set(sessionId, { userId: session.userId, secretHash: newSecretHash, expiresAt });
    return session.userId;
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async deleteExpired(now: Date): Promise<number> {
    const before = this.sessions.size;
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
    return before - this.sessions.size;
  }
}
