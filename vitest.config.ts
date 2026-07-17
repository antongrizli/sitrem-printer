import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [['test/**/*.test.tsx', 'jsdom']],
    setupFiles: ['./test/setup.ts'],
    clearMocks: true,
  },
});
