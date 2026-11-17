import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createReceiver } from './receiver.ts';

// Configuration (env):
//   PORT            default 4000
//   WEBHOOK_SECRET  one or more endpoint secrets (whsec_...), separated by spaces.
//                   When empty, signatures are NOT checked.
const port = Number(process.env.PORT ?? 4000);
const secrets = (process.env.WEBHOOK_SECRET ?? '').split(' ').filter(Boolean);

const log = (entry: Record<string, unknown>): void => {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));
};

const server = createServer(
  createReceiver({
    secrets,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    random: Math.random,
    sleep: (ms) => sleep(ms),
    log,
  }),
);

server.listen(port, () => {
  log({ msg: 'receiver listening', port, verify_signatures: secrets.length > 0 });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
