import { loadConfig } from './config';
import { connectDatabase, disconnectDatabase, isDatabaseConnected } from './config/database';
import { createApp } from './app';
import { logger } from './utils/logger';

async function main() {
  const config = loadConfig();
  await connectDatabase(config.mongoUri, config.dnsServers);

  const app = createApp({ isDbConnected: isDatabaseConnected, corsOrigins: config.corsOrigins });
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'MJ server listening');
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: { message: (err as Error).message } }, 'Failed to start');
  process.exit(1);
});
