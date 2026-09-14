-- CreateTable
CREATE TABLE `RoomActivityLog` (
    `id` VARCHAR(191) NOT NULL,
    `roomSlug` VARCHAR(64) NOT NULL,
    `identity` VARCHAR(64) NOT NULL,
    `userId` VARCHAR(32) NULL,
    `displayName` VARCHAR(64) NOT NULL,
    `event` VARCHAR(32) NOT NULL,
    `body` VARCHAR(400) NULL,
    `context` JSON NULL,
    `ip` VARCHAR(45) NULL,
    `userAgent` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RoomActivityLog_roomSlug_createdAt_idx`(`roomSlug`, `createdAt`),
    INDEX `RoomActivityLog_identity_createdAt_idx`(`identity`, `createdAt`),
    INDEX `RoomActivityLog_userId_idx`(`userId`),
    INDEX `RoomActivityLog_createdAt_id_idx`(`createdAt`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
