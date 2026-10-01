import { describeApi } from "./suites/all";

// The whole API over HTTP, with accounts and circuits kept in memory.
describeApi("memory");
