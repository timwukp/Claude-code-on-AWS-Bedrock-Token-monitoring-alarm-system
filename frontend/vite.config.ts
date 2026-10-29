import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static SPA build → uploaded to the private S3 bucket and served via CloudFront (OAC).
export default defineConfig({
  plugins: [react()],
  // 'hidden': maps are emitted for local debugging but the bundle carries no sourceMappingURL, and
  // scripts/deploy-frontend.sh excludes *.map from the upload (feature-47).
  build: { outDir: 'dist', sourcemap: 'hidden' },
});
