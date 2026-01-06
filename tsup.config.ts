import { defineConfig } from 'tsup';
import { readFileSync } from 'fs';
import { join } from 'path';

const packageJson = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));

export default defineConfig({
  entry: ['src/bin/aicmt.ts', 'src/cli.ts'],
  format: ['cjs'],
  clean: true,
  sourcemap: true,
  target: 'node16',
  define: {
    '__APP_VERSION__': JSON.stringify(packageJson.version),
  },
});
