import { Logger } from "@nestjs/common";
import { AppConfig } from "./config/app-config";
import { StartupError } from "./config/startup-error";
import { createWorker } from "./worker-app";

async function main(): Promise<void> {
  const worker = await createWorker();
  const { jobConcurrency } = worker.get(AppConfig);
  new Logger("CircuitLab").log(`Worker taking truth-table jobs, ${Math.max(1, jobConcurrency)} at a time`);
}

main().catch((error: unknown) => {
  // A problem in the setup gets one clear line; anything else is a bug, so the whole stack.
  if (error instanceof StartupError) new Logger("CircuitLab").error(error.message);
  else console.error(error);
  process.exit(1);
});
