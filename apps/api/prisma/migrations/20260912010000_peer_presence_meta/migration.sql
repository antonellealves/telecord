-- Anuncio carregado pelo roster do modo direto.
--
-- No transporte cfsfu (Cloudflare Realtime SFU) o par precisa dizer aos outros
-- qual `sessionId`/`trackName` publicou -- o SFU nao tem descoberta. Esse
-- anuncio viaja no proprio heartbeat, nesta coluna. Nulo nos modos LiveKit e
-- P2P, que nao a usam.

-- AlterTable
ALTER TABLE `PeerPresence` ADD COLUMN `meta` JSON NULL;
