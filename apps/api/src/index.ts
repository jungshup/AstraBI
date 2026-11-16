import { createApiServer, initializeDatabase, listen, closeDatabase } from './server.js';

const port = Number(process.env.PORT ?? 4000);
const server = createApiServer();
await initializeDatabase();
await listen(server, port);
console.log(`AstraBI API listening on http://localhost:${port}`);

function shutdown(): void {
  server.close((error) => {
    if (error) {
      console.error('Failed to close API server cleanly:', error);
      process.exitCode = 1;
    }
    void closeDatabase();
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
