import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Vite serves the dashboard in development (`npm run dev`, http://localhost:5173) and bundles it
// into static files in dist/ for production (`npm run build`). The same file configures Vitest.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  test: { include: ['test/**/*.test.ts'] },
});
