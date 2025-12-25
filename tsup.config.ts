import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin/ai-committer.ts', 'src/cli.ts'],
  format: ['cjs'],
  clean: true,
  sourcemap: true,
  target: 'node18',
});
