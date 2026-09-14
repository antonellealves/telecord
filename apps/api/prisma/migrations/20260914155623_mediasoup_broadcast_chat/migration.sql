-- Chat/soundboard do transporte mediasoup, por polling (ver schema.prisma
-- para o porquê de nao ser DataProducer/DataConsumer nativo por ora).

-- CreateTable
CREATE TABLE `RoomBroadcastMessage` (
    `id` VARCHAR(191) NOT NULL,
    `roomSlug` VARCHAR(64) NOT NULL,
    `fromPeer` VARCHAR(64) NOT NULL,
    `displayName` VARCHAR(64) NOT NULL,
    `body` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `RoomBroadcastMessage_roomSlug_createdAt_idx`(`roomSlug`, `createdAt`),
    INDEX `RoomBroadcastMessage_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Limpeza automatica, mesmo padrao de PeerSignal: mensagem que ninguem
-- precisa mais (a sala ja esvaziou ha muito) nao serve para nada acumulada.
ALTER TABLE `RoomBroadcastMessage` TTL = `expiresAt` + INTERVAL 1 HOUR;
