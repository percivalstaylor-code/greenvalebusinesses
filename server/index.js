import { loadConfig, describeConfig, validateConfig } from './config.js';
import { createStorage } from './storage/index.js';
import { Budget } from './budget.js';
import { PlacesClient } from './places.js';
import { Discovery } from './discovery.js';
import { loadBoundary } from './boundary.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const { problems, warnings } = validateConfig(cfg);
console.log('Greenvale Business Map configuration:', describeConfig(cfg));
warnings.forEach((w) => console.warn(`warning: ${w}`));
if (problems.length) {
  problems.forEach((p) => console.error(`error: ${p}`));
  process.exit(1);
}

const storage = await createStorage(cfg);
const budget = new Budget(storage, cfg.limits);
const places = new PlacesClient(cfg.places, budget);
const boundary = loadBoundary();
const discovery = new Discovery({ places, storage, boundary, cfg });
const app = createApp({ cfg, storage, budget, discovery, boundary });

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`Listening on http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close();
  await storage.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
