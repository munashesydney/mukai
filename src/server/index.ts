import { startApiServer } from './app';

const port = Number(process.env.PORT ?? 47831);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be between 1 and 65535');
startApiServer(port)
  .then(({ server, url, shutdown }) => {
    console.info(`Mukai API listening at ${url}`);
    const stop = async () => {
      await shutdown();
      server.close(() => process.exit(0));
      server.closeAllConnections();
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  })
  .catch((error) => {
    console.error('Failed to start Mukai API:', error);
    process.exitCode = 1;
  });
