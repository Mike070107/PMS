/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_BUILD_COMMIT?: string;
  readonly VITE_LEGACY_BASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
  readonly BASE_URL: string;
}
