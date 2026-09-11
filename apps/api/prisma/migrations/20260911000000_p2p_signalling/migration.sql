-- Sinalizacao do modo P2P.
--
-- Duas tabelas que existem so para os navegadores se acharem: quem esta na
-- sala (`PeerPresence`) e os envelopes de SDP/ICE entre eles (`PeerSignal`).
-- Depois do aperto de mao, nenhum byte de midia passa por aqui.
--
-- Ao final ha dois ALTER TABLE com TTL, que o Prisma nao sabe emitir.

-- CreateTable
CREATE TABLE `PeerPresence` (
    `id` VARCHAR(191) NOT NULL,
    `roomSlug` VARCHAR(64) NOT NULL,
    `peerId` VARCHAR(64) NOT NULL,
    `userId` VARCHAR(32) NULL,
    `displayName` VARCHAR(64) NOT NULL,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PeerPresence_roomSlug_peerId_key`(`roomSlug`, `peerId`),
    INDEX `PeerPresence_roomSlug_lastSeenAt_idx`(`roomSlug`, `lastSeenAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PeerSignal` (
    `id` VARCHAR(191) NOT NULL,
    `roomSlug` VARCHAR(64) NOT NULL,
    `fromPeer` VARCHAR(64) NOT NULL,
    `toPeer` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(8) NOT NULL,
    `payload` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `PeerSignal_roomSlug_toPeer_createdAt_idx`(`roomSlug`, `toPeer`, `createdAt`),
    INDEX `PeerSignal_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Limpeza automatica.
--
-- As duas sao efemeras por natureza: presenca que ninguem renova esta morta, e
-- sinal que ninguem leu em dois minutos nao serve mais -- a negociacao que ele
-- pertencia ja falhou ou ja terminou. O servico tambem apaga o sinal na
-- ENTREGA; o TTL e a rede de seguranca para o que nunca foi buscado.
--
-- Se o cluster nao suportar TTL, estas duas linhas falham e a migracao inteira
-- para; nesse caso, remova-as e agende a limpeza por fora.
ALTER TABLE `PeerSignal` TTL = `expiresAt` + INTERVAL 1 MINUTE;
ALTER TABLE `PeerPresence` TTL = `lastSeenAt` + INTERVAL 1 HOUR;
