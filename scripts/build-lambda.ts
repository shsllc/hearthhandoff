// Bundles src/lambda.ts into dist/lambda.mjs for the nodejs24.x runtime.
// The AWS SDK v3 ships with the runtime, so it stays external.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/lambda.ts'],
  outfile: 'dist/lambda.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external: ['@aws-sdk/*', 'node:*'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
