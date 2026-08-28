/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the PulseStream API, e.g. https://api.example.com/api/v1 */
  readonly VITE_PULSESTREAM_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
