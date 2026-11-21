// Bundles src/server.ts and its dependencies into one ES module, dist/server.js (design D2).
// The output is deterministic for the same sources and esbuild version.
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outfile = fileURLToPath(new URL('../dist/server.js', import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: ['src/server.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  banner: {
    js: [
      '#!/usr/bin/env node',
      '// Built by power/mcp/scripts/build.mjs from power/mcp/src. Do not edit; run `pnpm --dir power/mcp build`.',
      "import { createRequire as __ossuaryCreateRequire } from 'node:module';",
      'const require = __ossuaryCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
chmodSync(outfile, 0o755);
process.stdout.write(`built ${outfile}\n`);
