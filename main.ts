// Boot: bind an ephemeral port, register it with the environment, then serve
// until the environment says the trial is done. Never binds a fixed port —
// the register call is how the environment finds this process.

import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (!envUrl) {
  console.error('[forge-fresh] MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const server = createApp(token);

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') {
  console.error('[forge-fresh] no address after listen');
  process.exit(1);
}
const port = address.port;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function registerWithRetry(): Promise<void> {
  let delayMs = 250;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        console.error(`[forge-fresh] register refused: ${response.status} ${await response.text()}`);
        process.exit(1);
      }
    } catch {
      // The environment may still be starting; retry below.
    }
    await sleep(delayMs);
    delayMs = Math.min(2000, delayMs * 2);
  }
}

await registerWithRetry();

for (;;) {
  await sleep(500);
  try {
    const response = await fetch(`${envUrl}/done`);
    if (response.ok) {
      const body = (await response.json()) as { done?: boolean };
      if (body.done) break;
    }
  } catch {
    // Keep serving; the environment is the only clock that matters.
  }
}

await new Promise<void>((resolve) => server.close(() => resolve()));
process.exit(0);
