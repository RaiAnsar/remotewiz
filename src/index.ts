import { loadRuntimeConfig } from "./config.js";
import { RemoteWizApp } from "./app.js";
import { WebAdapter } from "./adapters/web.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { logError, logInfo, logWarn } from "./utils/log.js";

async function main(): Promise<void> {
  const { appConfig, runtimeConfig } = loadRuntimeConfig(process.cwd());

  const app = new RemoteWizApp(appConfig, runtimeConfig);

  const webAdapter = new WebAdapter(app, runtimeConfig);
  app.registerAdapter(webAdapter);

  if (runtimeConfig.discordToken) {
    const discordAdapter = new DiscordAdapter(app, runtimeConfig);
    app.registerAdapter(discordAdapter);
  } else {
    logWarn("DISCORD_TOKEN not set; Discord adapter disabled");
  }

  await app.start();

  logInfo("RemoteWiz started", {
    projects: Object.keys(appConfig.projects),
    web: `http://${runtimeConfig.webBindHost}:${runtimeConfig.webPort}`,
    discord: Boolean(runtimeConfig.discordToken),
  });

  let shutdownRequested = false;

  const shutdown = async (signal: string) => {
    if (shutdownRequested) {
      logInfo("Force exit");
      process.exit(1);
    }
    shutdownRequested = true;
    logInfo(`Received ${signal}; shutting down (press again to force)`);
    try {
      // Give graceful shutdown 3 seconds, then force exit
      const timer = setTimeout(() => {
        logWarn("Graceful shutdown timed out, forcing exit");
        process.exit(1);
      }, 3000);
      timer.unref();
      await app.stop();
    } catch (error) {
      logError("Shutdown error", error);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  logError("Fatal startup error", error);
  process.exit(1);
});
