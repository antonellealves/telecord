-- Transporte padrao da sala (LiveKit ou mediasoup) -- rotulo exibido no
-- diretorio e no painel admin. Nao afeta o transporte que cada navegador
-- escolhe ao entrar (isso continua sendo preferencia local, `TransportPicker`).
--
-- Comando de moderacao pendente por par, para o modo mediasoup: o SFU nao tem
-- um servico de controle central como o LiveKit, entao mutar/mover so
-- funcionam se o proprio cliente cooperar -- ele le isto a cada heartbeat.

-- CreateEnum (MySQL/TiDB nao tem CREATE TYPE; o enum vira parte da coluna)
-- AlterTable
ALTER TABLE `Room` ADD COLUMN `transport` ENUM('LIVEKIT', 'MEDIASOUP') NOT NULL DEFAULT 'LIVEKIT';

-- AlterTable
ALTER TABLE `PeerPresence` ADD COLUMN `adminCommand` JSON NULL;
