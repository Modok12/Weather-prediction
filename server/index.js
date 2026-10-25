// Start the server: node index.js (reads settings from environment variables).
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createPaystack } from './paystack.js';
import { createFileStore } from './store.js';
import { createHandler } from './app.js';

const here = fileURLToPath(new URL('.', import.meta.url));

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing environment variable ${name}. See server/.env.example.`);
    process.exit(1);
  }
  return v;
}

const config = {
  secretKey: required('PAYSTACK_SECRET_KEY'),
  tokenSecret: required('TOKEN_SECRET'),
  planCodes: required('PAYSTACK_PLAN_CODES').split(',').map((s) => s.trim()).filter(Boolean),
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  staticDir: resolve(here, '../gas-app'),
};
const port = Number(process.env.PORT) || 3000;
const store = await createFileStore(resolve(here, process.env.DATA_FILE || 'data/subscribers.json'));

createServer(createHandler({ paystack: createPaystack(config.secretKey), store, config }))
  .listen(port, () => console.log(`Gas Level running on http://localhost:${port}`));
