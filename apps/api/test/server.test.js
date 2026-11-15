import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApiServer, listen } from '../dist/server.js';

const server = createApiServer();
const port = 4100 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;

before(async () => listen(server, port));
after(() => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve(undefined));
}));

test('health endpoint reports healthy service', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'astrabi-api' });
});

test('status endpoint returns runtime information', async () => {
  const response = await fetch(`${baseUrl}/api/v1/status`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.name, 'AstraBI');
  assert.equal(body.status, 'operational');
  assert.ok(Number.isNaN(Date.parse(body.checkedAt)) === false);
});

test('unknown routes return a JSON 404', async () => {
  const response = await fetch(`${baseUrl}/missing`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
});
