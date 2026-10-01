import { Logger } from "@nestjs/common";
import { createApp } from "./app";
import { AppConfig } from "./config/app-config";
import { StartupError } from "./config/startup-error";

async function main(): Promise<void> {
  const app = await createApp();
  const { port } = app.get(AppConfig);
  await app.listen(port);
  new Logger("CircuitLab").log(`API listening on http://localhost:${port}/v1 (health: /health)`);
}

main().catch((error: unknown) => {
  // A problem in the setup gets one clear line; anything else is a bug, so the whole stack.
  if (error instanceof StartupError) new Logger("CircuitLab").error(error.message);
  else console.error(error);
  process.exit(1);
});
