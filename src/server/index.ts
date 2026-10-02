import { startApiServer } from './app';

const port = Number(process.env.PORT ?? 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be between 1 and 65535');
startApiServer(port)
  .then(({ server, url }) => {
    console.info(`Mukai API listening at ${url}`);
    const shutdown = () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  })
  .catch((error) => {
    console.error('Failed to start Mukai API:', error);
    process.exitCode = 1;
  });
