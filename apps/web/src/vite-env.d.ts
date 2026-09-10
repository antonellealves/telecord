/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL pública do servidor LiveKit (wss://...). Vai para o bundle. */
  readonly VITE_LIVEKIT_URL?: string;
  /** Endpoint do token. Default: /api/token. */
  readonly VITE_TOKEN_ENDPOINT?: string;
  /** Origem do serviço de autenticação. Vazia = app sem contas. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
