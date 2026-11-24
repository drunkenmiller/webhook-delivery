// Types for the build-time variables Vite exposes on import.meta.env. Only names starting with
// VITE_ are exposed to browser code (so server secrets can't leak into the bundle by accident).
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
