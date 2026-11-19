import { createApp } from './app.ts';

const environmentOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const requestTimeoutMs = 30_000;
const initialRetryMs = 250;
const maximumRetryMs = 2_000;

if (environmentOrigin === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is required\n');
  process.exit(1);
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function retryDelay(attempt: number): number {
  return Math.min(maximumRetryMs, initialRetryMs * 2 ** Math.min(attempt, 8));
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${environmentOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`registration rejected with HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('registration rejected')) throw error;
    }
    await sleep(retryDelay(attempt));
  }
}

async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${environmentOrigin}/done`, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.ok) {
        const status = await response.json() as { done?: unknown };
        if (status.done === true) return;
      }
    } catch {
      // The grading environment may still be starting or writing its export.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('forge failed to bind an ephemeral TCP port');
  }

  await register(address.port);
  await waitUntilDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

try {
  await main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[forge] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
