import { createApiServer, listen } from './server.js';

const port = Number(process.env.PORT ?? 4000);
const server = createApiServer();

await listen(server, port);
console.log(`AstraBI API listening on http://localhost:${port}`);

function shutdown(): void {
  server.close((error) => {
    if (error) {
      console.error('Failed to close API server cleanly:', error);
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
