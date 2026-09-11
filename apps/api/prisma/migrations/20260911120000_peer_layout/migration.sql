-- Arrumacao dos quadros no modo direto.
--
-- A posicao e de QUEM OLHA: cada pessoa arruma a propria visao, e arrastar o
-- quadro de alguem nao move esse quadro na tela dos outros. Dai a chave ser
-- (sala, dono da visao).

-- CreateTable
CREATE TABLE `PeerLayout` (
    `id` VARCHAR(191) NOT NULL,
    `roomSlug` VARCHAR(64) NOT NULL,
    `ownerId` VARCHAR(64) NOT NULL,
    `tiles` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PeerLayout_roomSlug_ownerId_key`(`roomSlug`, `ownerId`),
    INDEX `PeerLayout_updatedAt_idx`(`updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Arrumacao que ninguem toca ha meio ano nao vale o espaco, e a pessoa nem
-- lembra dela. Sem TTL esta tabela cresce com cada sala que alguem visitou uma
-- vez. Se o cluster nao suportar TTL, remova esta linha.
ALTER TABLE `PeerLayout` TTL = `updatedAt` + INTERVAL 180 DAY;
