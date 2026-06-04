import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static SPA build → uploaded to the private S3 bucket and served via CloudFront (OAC).
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
});
