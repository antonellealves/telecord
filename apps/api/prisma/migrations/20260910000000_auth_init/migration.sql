-- Migration inicial da fatia de autenticacao (PLANO.md 4.1).
--
-- Gerada com `prisma migrate diff --from-empty`, e nao com `migrate dev`:
-- `migrate dev` exige um shadow database, e o TiDB Starter nao da um segundo
-- schema descartavel de graca. O SQL abaixo e o mesmo, e `migrate deploy`
-- aplica sem shadow.
--
-- Nao ha FOREIGN KEY em lugar nenhum: com `relationMode = "prisma"` a
-- integridade e resolvida na aplicacao, porque o TiDB aceita a sintaxe mas nao
-- faz valer a restricao. Em troca, cada coluna de FK ganhou INDEX explicito,
-- que o Prisma nao cria sozinho nesse modo.

-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(320) NOT NULL,
    `emailVerifiedAt` DATETIME(3) NULL,
    `username` VARCHAR(32) NOT NULL,
    `displayName` VARCHAR(32) NOT NULL,
    `avatarUrl` VARCHAR(512) NULL,
    `passwordHash` VARCHAR(255) NULL,
    `role` ENUM('USER', 'ADMIN') NOT NULL DEFAULT 'USER',
    `status` ENUM('ACTIVE', 'SUSPENDED', 'BANNED') NOT NULL DEFAULT 'ACTIVE',
    `lastSeenAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    UNIQUE INDEX `User_username_key`(`username`),
    INDEX `User_createdAt_id_idx`(`createdAt`, `id`),
    INDEX `User_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserSettings` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `theme` VARCHAR(16) NOT NULL DEFAULT 'dark',
    `locale` VARCHAR(16) NOT NULL DEFAULT 'pt-BR',
    `inputDeviceId` VARCHAR(255) NULL,
    `outputDeviceId` VARCHAR(255) NULL,
    `videoDeviceId` VARCHAR(255) NULL,
    `inputVolume` INTEGER NOT NULL DEFAULT 100,
    `outputVolume` INTEGER NOT NULL DEFAULT 100,
    `noiseSuppression` BOOLEAN NOT NULL DEFAULT true,
    `echoCancellation` BOOLEAN NOT NULL DEFAULT true,
    `pushToTalk` BOOLEAN NOT NULL DEFAULT false,
    `pushToTalkKey` VARCHAR(32) NULL,
    `joinMuted` BOOLEAN NOT NULL DEFAULT true,
    `joinDeafened` BOOLEAN NOT NULL DEFAULT false,
    `defaultCameraOff` BOOLEAN NOT NULL DEFAULT true,
    `notificationPrefs` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `UserSettings_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OAuthAccount` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `providerAccountId` VARCHAR(255) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OAuthAccount_userId_idx`(`userId`),
    UNIQUE INDEX `OAuthAccount_provider_providerAccountId_key`(`provider`, `providerAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RefreshToken` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `replacedById` VARCHAR(191) NULL,
    `ip` VARCHAR(45) NULL,
    `userAgent` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `RefreshToken_tokenHash_key`(`tokenHash`),
    INDEX `RefreshToken_userId_idx`(`userId`),
    INDEX `RefreshToken_expiresAt_idx`(`expiresAt`),
    INDEX `RefreshToken_replacedById_idx`(`replacedById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailToken` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `purpose` ENUM('VERIFY', 'RESET') NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `EmailToken_tokenHash_key`(`tokenHash`),
    INDEX `EmailToken_userId_idx`(`userId`),
    INDEX `EmailToken_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

