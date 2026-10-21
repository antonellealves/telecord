/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL pública do servidor LiveKit (wss://...). Vai para o bundle. */
  readonly VITE_LIVEKIT_URL?: string;
  /** Endpoint do token. Default: /api/token. */
  readonly VITE_TOKEN_ENDPOINT?: string;
  /** Origem do serviço de autenticação. Vazia = app sem contas. */
  readonly VITE_API_URL?: string;
  /** `1` liga o gancho de E2EE por quadro da voz (sem criptografia ainda). */
  readonly VITE_VOICE_E2EE_HOOK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
