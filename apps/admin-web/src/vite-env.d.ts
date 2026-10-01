/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_BUILD_DATE?: string;
  readonly VITE_BUILD_COMMIT?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
