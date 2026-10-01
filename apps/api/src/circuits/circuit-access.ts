import { forbidden, type ShareRole, type Visibility } from "@circuitlab/api-contract";

/**
 * Who may do what with a circuit, in one place. Everything follows from how a person has access to
 * the circuit:
 *
 *   access    read and simulate   edit (PUT, rename)   manage (delete, share, visibility)
 *   owner           yes                  yes                    yes
 *   editor          yes                  yes                    no
 *   viewer          yes                  no                     no
 *   public          yes                  no                     no
 *   none            404                  404                    404
 *
 * Without access the circuit doesn't exist as far as the caller can tell (404). With access but
 * not enough of it, the answer is 403.
 */
export type CircuitAccess = "owner" | ShareRole | "public";

export type CircuitAction = "read" | "edit" | "manage";

const ALLOWED: Readonly<Record<CircuitAction, readonly CircuitAccess[]>> = {
  read: ["owner", "editor", "viewer", "public"],
  edit: ["owner", "editor"],
  manage: ["owner"],
};

/** What access depends on, as storage hands it over (queries.sql: access_of). */
export interface AccessFacts {
  readonly ownerId: string;
  readonly visibility: Visibility;
  /** The circuit's current version, for If-Match. */
  readonly version: number;
  /** The role the circuit is shared with the caller, if it is. */
  readonly sharedRole: ShareRole | undefined;
}

/** How `userId` (undefined: signed out) has access to the circuit, if at all. A share beats public visibility. */
export function accessOf(facts: AccessFacts, userId: string | undefined): CircuitAccess | undefined {
  if (userId !== undefined && facts.ownerId === userId) return "owner";
  if (facts.sharedRole !== undefined) return facts.sharedRole;
  if (facts.visibility === "public") return "public";
  return undefined;
}

export function allows(access: CircuitAccess, action: CircuitAction): boolean {
  return ALLOWED[action].includes(access);
}

/** The 403 for an action that `access` doesn't allow, saying why. */
export function denied(access: CircuitAccess, action: CircuitAction): Error {
  if (action === "manage") return forbidden("Only the circuit's owner may delete it, share it, or change who can see it.");
  return access === "viewer"
    ? forbidden("This circuit is shared with you as a viewer: you can read and simulate it, but not change it.")
    : forbidden("This circuit is public: anyone can read and simulate it, but only its owner and editors can change it.");
}
