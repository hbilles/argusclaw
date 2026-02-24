import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/tests/**/*.ts', 'packages/*/dist/**/*.ts'],
    },
  },
});
