import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// ESM-safe absolute path to ../shared (no __dirname under "type": "module").
const sharedDir = fileURLToPath(new URL('../shared', import.meta.url));

// The unit tests here (envelope-crypto round-trip, CSV import validation) exercise pure
// logic and the standard WebCrypto SubtleCrypto API — which is identical in Node and
// workerd — so they run on the default Node pool. Binding-level behaviour (D1, Queues,
// Cloudflare Access JWT validation) is exercised end-to-end via `wrangler dev` and the
// pilot gate (SoW §5), not in these unit tests. This keeps the test toolchain decoupled
// from the wrangler/workerd runtime version.
export default defineConfig({
  resolve: {
    // Mirror the tsconfig path alias for the shared wire contract.
    alias: { '@shared': sharedDir },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
