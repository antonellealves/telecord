-- AlterTable
ALTER TABLE `Room` ADD COLUMN `channelId` VARCHAR(191) NULL,
    ADD COLUMN `position` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `Channel` (
    `slug` VARCHAR(64) NOT NULL,
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(48) NOT NULL,
    `description` VARCHAR(200) NULL,
    `emoji` VARCHAR(16) NULL,
    `visibility` ENUM('PUBLIC', 'UNLISTED') NOT NULL DEFAULT 'PUBLIC',
    `ownerId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Channel_slug_key`(`slug`),
    INDEX `Channel_ownerId_idx`(`ownerId`),
    INDEX `Channel_visibility_createdAt_id_idx`(`visibility`, `createdAt`, `id`),
    INDEX `Channel_createdAt_id_idx`(`createdAt`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ChannelMember` (
    `id` VARCHAR(191) NOT NULL,
    `channelId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `role` ENUM('OWNER', 'MOD', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ChannelMember_channelId_idx`(`channelId`),
    INDEX `ChannelMember_userId_idx`(`userId`),
    UNIQUE INDEX `ChannelMember_channelId_userId_key`(`channelId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Room_channelId_position_id_idx` ON `Room`(`channelId`, `position`, `id`);
