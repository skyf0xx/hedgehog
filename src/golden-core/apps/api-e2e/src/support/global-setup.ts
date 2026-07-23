import { killPort, waitForPortOpen } from '@nx/node/utils';

// Start services that the app needs to run (e.g. database, docker-compose,
// etc.). Vitest's `globalSetup` runs this once before the suite and, if a
// function is returned, runs it once after the suite as teardown.
export default async function setup() {
  console.log('\nSetting up...\n');

  const host = process.env.HOST ?? 'localhost';
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await waitForPortOpen(port, { host });

  return async function teardown() {
    console.log('\nTearing down...\n');
    await killPort(port);
  };
}
