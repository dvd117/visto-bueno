import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/server/**/*.test.ts', 'src/shared/**/*.test.ts'],
          exclude: ['tests/client/**'],
        },
      },
      {
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['tests/client/**/*.test.{ts,tsx}', 'src/client/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
