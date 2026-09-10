-- Salas persistidas, soundboard enviado e registro de eventos.
--
-- Gerada com `prisma migrate diff --from-url` contra o banco com a migracao
-- anterior ja aplicada, e nao com `migrate dev`: `migrate dev` exige shadow
-- database, e o TiDB Starter nao da um segundo schema descartavel de graca.
--
-- Continua sem FOREIGN KEY em lugar nenhum, pelo mesmo motivo da migracao
-- anterior: `relationMode = "prisma"` resolve a integridade na aplicacao
-- porque o TiDB aceita a sintaxe de FK e nao faz valer a restricao. Cada
-- coluna de FK ganhou INDEX explicito.
--
-- Ao final ha um ALTER TABLE com TTL, que o Prisma nao sabe emitir. Ver o
-- comentario la embaixo.
-- CreateTable
CREATE TABLE `Room` (
    `slug` VARCHAR(64) NOT NULL,
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(48) NOT NULL,
    `description` VARCHAR(200) NULL,
    `emoji` VARCHAR(16) NULL,
    `visibility` ENUM('PUBLIC', 'UNLISTED') NOT NULL DEFAULT 'PUBLIC',
    `ownerId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `lastActiveAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Room_slug_key`(`slug`),
    INDEX `Room_ownerId_idx`(`ownerId`),
    INDEX `Room_visibility_lastActiveAt_id_idx`(`visibility`, `lastActiveAt`, `id`),
    INDEX `Room_createdAt_id_idx`(`createdAt`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RoomMember` (
    `id` VARCHAR(191) NOT NULL,
    `roomId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `role` ENUM('OWNER', 'MOD', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RoomMember_roomId_idx`(`roomId`),
    INDEX `RoomMember_userId_idx`(`userId`),
    UNIQUE INDEX `RoomMember_roomId_userId_key`(`roomId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Sound` (
    `id` VARCHAR(191) NOT NULL,
    `roomId` VARCHAR(191) NULL,
    `uploadedById` VARCHAR(191) NULL,
    `label` VARCHAR(32) NOT NULL,
    `emoji` VARCHAR(16) NULL,
    `mimeType` VARCHAR(32) NOT NULL,
    `byteSize` INTEGER NOT NULL,
    `durationMs` INTEGER NULL,
    `checksum` CHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deletedAt` DATETIME(3) NULL,

    INDEX `Sound_roomId_createdAt_id_idx`(`roomId`, `createdAt`, `id`),
    INDEX `Sound_uploadedById_idx`(`uploadedById`),
    INDEX `Sound_roomId_checksum_idx`(`roomId`, `checksum`),
    INDEX `Sound_createdAt_id_idx`(`createdAt`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SoundBlob` (
    `soundId` VARCHAR(191) NOT NULL,
    `data` LONGBLOB NOT NULL,

    PRIMARY KEY (`soundId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MediaSession` (
    `id` VARCHAR(191) NOT NULL,
    `roomSlug` VARCHAR(64) NOT NULL,
    `roomId` VARCHAR(191) NULL,
    `identity` VARCHAR(64) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `participantName` VARCHAR(64) NOT NULL,
    `joinedAt` DATETIME(3) NOT NULL,
    `leftAt` DATETIME(3) NULL,
    `durationSeconds` INTEGER NULL,
    `joinEventId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `MediaSession_joinEventId_key`(`joinEventId`),
    INDEX `MediaSession_roomSlug_identity_leftAt_idx`(`roomSlug`, `identity`, `leftAt`),
    INDEX `MediaSession_joinedAt_id_idx`(`joinedAt`, `id`),
    INDEX `MediaSession_userId_idx`(`userId`),
    INDEX `MediaSession_roomId_idx`(`roomId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SystemLog` (
    `id` VARCHAR(191) NOT NULL,
    `level` ENUM('DEBUG', 'INFO', 'WARN', 'ERROR') NOT NULL,
    `scope` VARCHAR(32) NOT NULL,
    `event` VARCHAR(64) NOT NULL,
    `message` VARCHAR(500) NOT NULL,
    `userId` VARCHAR(32) NULL,
    `roomSlug` VARCHAR(64) NULL,
    `ip` VARCHAR(45) NULL,
    `userAgent` VARCHAR(255) NULL,
    `context` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SystemLog_createdAt_id_idx`(`createdAt`, `id`),
    INDEX `SystemLog_level_createdAt_idx`(`level`, `createdAt`),
    INDEX `SystemLog_scope_createdAt_idx`(`scope`, `createdAt`),
    INDEX `SystemLog_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(32) NULL,
    `actorLabel` VARCHAR(64) NOT NULL,
    `action` VARCHAR(48) NOT NULL,
    `targetType` VARCHAR(32) NOT NULL,
    `targetId` VARCHAR(64) NOT NULL,
    `summary` VARCHAR(300) NOT NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `ip` VARCHAR(45) NULL,
    `userAgent` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_createdAt_id_idx`(`createdAt`, `id`),
    INDEX `AuditLog_actorId_idx`(`actorId`),
    INDEX `AuditLog_targetType_targetId_idx`(`targetType`, `targetId`),
    INDEX `AuditLog_action_createdAt_idx`(`action`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


-- Retencao do log tecnico: 30 dias, apagados pelo proprio TiDB.
--
-- TTL e sintaxe de TiDB e nao existe no MySQL, entao o Prisma nao a emite e
-- ela entra a mao aqui. Sem isto o `SystemLog` cresce para sempre: e a tabela
-- que mais recebe escrita no sistema, e a de menor valor depois de algumas
-- semanas.
--
-- O `AuditLog` NAO ganha TTL, de proposito. Ele existe para responder
-- perguntas sobre o passado -- expira-lo e apagar a unica copia da resposta.
--
-- Se o cluster nao suportar TTL, esta linha falha e a migracao inteira para;
-- nesse caso, remova-a e agende a limpeza por fora.
ALTER TABLE `SystemLog` TTL = `createdAt` + INTERVAL 30 DAY;
