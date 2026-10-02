# CircuitLab accounts and access design (phase 7)

Circuits belong to accounts. Each one is private to its owner until the owner shares it with
particular people or makes it public. `npm run demo:auth` walks through all of it over HTTP, and
the integration tests (phase 8) check every rule against both kinds of storage.

## Who may do what

Everything follows from how a person has access to a circuit. The rules live in one small file,
[`circuit-access.ts`](../apps/api/src/circuits/circuit-access.ts), and the tests run this table
literally, for a private and a public circuit:

| Access | Read, simulate, truth table | Edit (`PUT`, rename) | Manage (delete, share, visibility) |
| --- | --- | --- | --- |
| Owner | yes | yes | yes |
| Editor (shared) | yes | yes | 403 |
| Viewer (shared) | yes | 403 | 403 |
| Public circuit, anyone | yes | 403 | 403 |
| No access | 404 | 404 | 404 |

**Three status codes, three meanings.**
- **401:** "sign in first", or "your token is no good". It always carries a
  `WWW-Authenticate: Bearer ...` header, as HTTP requires.
- **403:** "you can see this circuit, but may not do that to it".
- **404:** "no such circuit". This is also the answer when the circuit exists but the caller may not
  see it, word for word. Otherwise anyone could probe ids and learn which private circuits exist.
  Phase 3's spec already promised this rule.

**A share beats public visibility.** An editor of a public circuit can still edit it.

**Permissions are looked up on every request, never stored in the token.** If Ada stops sharing a
circuit with Bob, Bob loses access on his next request, not when his token expires.

## Private, shared, public

- **New circuits are private.** Only the owner may change `visibility`, with `PATCH`.
- **`visibility` isn't part of a circuit's content.** So an editor's `PUT`, which replaces
  everything else, can't publish a circuit by accident or on purpose.
- **Sharing is by email address**, as `viewer` or `editor`. Sharing again with the same person
  changes their role: 200 instead of 201.
- **Removing a share.** The owner can remove anyone; anyone can remove their own share, i.e. leave.
- **Lists have three scopes:** `owned`, `shared` (with me), and `public`.
  - **Default:** `owned` when signed in, `public` when signed out.
  - **Links:** the `next` link always names the scope, so following it lists the same circuits.
- **Simulation history:** the owner sees everyone's runs of their circuit; anyone else sees only
  their own.

## Accounts and passwords

- **Argon2id**, with OWASP's recommended minimum settings (19 MiB of memory, 2 passes).
  - **Why memory matters:** it makes guessing expensive even on graphics cards.
  - **Cost:** about 30 ms per hash, on Node's thread pool rather than the event loop.
  - **Upgrades:** the settings are stored in each hash, so raising them later re-hashes each
    password at its owner's next sign-in.
- **Passwords: 15 to 256 characters, any characters.** That is NIST SP 800-63B's rule for a
  password that is the only factor: long passphrases rather than "one digit and one symbol" rules.
  - **Counting:** in Unicode characters, so 15 emoji are 15 characters.
  - **Normalization:** passwords are normalized (NFKC) before hashing, so the same passphrase typed
    on two keyboards is the same password.
- **Email addresses are compared in lower case**, so there is one account per address.
- **Sign-in gives one answer for "no such account" and "wrong password".** It also takes the same
  time for both: for an unknown address, the password is checked against a decoy hash. Neither the
  answer nor its timing tells a stranger whether an address has an account. (Registering with a
  taken address does say so, 409, as nearly every site does.)
- **Throttling.** After 5 failed sign-ins for one account from one IP address, that pair gets 429
  for 15 minutes.
  - **Keyed by account and address together**, so an attacker can't lock someone out by failing
    sign-ins for their account from elsewhere.
  - **Shared by every API instance (phase 10).** The counts are in Redis, so an attacker can't make
    5 guesses on each instance. A Lua script counts each failure atomically; keys are hashed, so
    addresses aren't stored as they are. When Redis is down, sign-in answers 503 rather than
    skipping the throttle. See [caching-and-jobs.md](caching-and-jobs.md).
  - **Without Redis**, the counts are kept in the process's memory, at most 100,000 entries. Phase
    8's tests caught a slowdown once that table was full; see [testing.md](testing.md).

## Tokens

Signing in returns two tokens.

**The access token** is a JWT, sent as `Authorization: Bearer <token>` and valid for 15 minutes.
- **Contents:** who the user is (`sub`), the issuer and audience, and when it expires. No roles,
  which could go stale.
- **Signature:** HMAC-SHA256 with a server secret (`JWT_SECRET`). That suits one service that both
  issues and checks tokens. If other services ever need to check tokens without being able to
  issue them, an asymmetric algorithm (EdDSA) replaces it.
- **Verification:**
  - **The algorithm is pinned to HS256.** A token claiming `alg: none`, or any other algorithm, is
    refused before its signature is even considered.
  - **Every claim is checked:** issuer, audience, and expiry.
  - **A bad token is always 401,** even on endpoints that work signed out. Quietly treating the
    request as anonymous would only make the user wonder where their circuits went.
- **Trade-off:** checking an access token doesn't touch the database, so it can't be revoked. It
  simply expires, which is why it is short.

**The refresh token** gets new tokens at `/auth/refresh`.
- **Format:** `<session id>.<secret>`, where the secret is 256 random bits. The `sessions` table
  stores only its SHA-256 hash, so a stolen copy of the table can't be used to sign in. A fast hash
  is fine here: slow hashing protects guessable secrets, and a random 256-bit secret isn't one.
- **Each refresh token works once.** Refreshing replaces the secret, in one compare-and-swap
  `UPDATE`, so of two refreshes racing with the same token only one wins.
- **Reuse ends the session.** If a replaced token comes back, two parties hold a copy of the same
  session, probably the user and a thief, and there is no telling which is which. The session ends
  for both, and the user signs in again. Their other sessions (other devices) are unaffected.
- **Sliding expiry:** a session ends after 30 days without a refresh.
- **Signing out** deletes the session. The access token lives out its 15 minutes, so clients
  should drop it too.
- **The account endpoints ignore the `Authorization` header.** A client that still sends its
  expired access token when calling `/auth/refresh` isn't turned away.
- **Token responses are never cached:** they carry `Cache-Control: no-store`.

**Why a Bearer header and not cookies?** The API serves programs as much as browsers, and a header
can't be sent by another website on the user's behalf, so there is no cross-site request forgery
to defend against. A browser front end (phase 13) could keep the refresh token in an `HttpOnly`
cookie; that would add CSRF protection to `/auth/refresh`.

## Storage

The migration `20261001210000_accounts_and_sharing` adds:
- **`circuits.visibility`,** private by default.
- **A required owner for every new circuit.** It is a `NOT VALID` check: enforced for new and
  changed rows, but it doesn't fail on circuits stored before accounts existed. Those stay
  ownerless and private, so nobody sees them, until they are given owners. Then
  `VALIDATE CONSTRAINT` completes the change. `db:check` shows such a circuit surviving the
  migration.
- **`circuit_shares`:** one row per circuit and person, with the role.
- **`sessions`:** one row per signed-in device, holding the hash of the current secret.
- **New list indexes,** one per scope and sort order. The public ones are partial
  (`WHERE visibility = 'public'`), so they stay small however many private circuits there are.

The in-memory storage follows the same rules, and the same integration tests run against both.

## Done in phase 10

- **The throttle is shared by every API instance,** in Redis (above).
- **Expired sessions are deleted on a schedule:** housekeeping runs `delete_expired_sessions` every
  10 minutes (a BullMQ job scheduler; a timer without Redis).

## Not done yet

| What | When |
| --- | --- |
| Email verification, password reset, changing a password, "sign out everywhere" | Not on the roadmap yet; the `sessions` table already supports the last |
| `trust proxy`, so the throttle sees the client's address rather than the reverse proxy's | Phase 13, when the deployed API gets a reverse proxy. Phase 11's Docker setup has none: its port forwarding passes on no client address (see [docker.md](docker.md#known-shortcuts)) |
| A grace period for two browser tabs refreshing the same token at the same moment (today the second one ends the session) | If it bothers users |
| A list of common passwords to refuse, as NIST also asks | With the account settings above |
