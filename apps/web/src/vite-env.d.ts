/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL pública do servidor LiveKit (wss://...). Vai para o bundle. */
  readonly VITE_LIVEKIT_URL?: string;
  /** Endpoint do token. Default: /api/token. */
  readonly VITE_TOKEN_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
