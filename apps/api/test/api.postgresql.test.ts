import { describeApi } from "./suites/all";

// The same tests against PostgreSQL: a fresh database (PGlite), migrated as in production.
describeApi("postgresql");
