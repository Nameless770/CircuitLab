/**
 * Something the operator must fix before the API can start: a bad setting, or a database that is
 * unreachable or not migrated. main() prints just the message, since a stack trace would bury it.
 */
export class StartupError extends Error {
  override readonly name = "StartupError";
}
