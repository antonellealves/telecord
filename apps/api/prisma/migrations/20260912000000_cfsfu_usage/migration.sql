-- Consumo estimado de egress do transporte cfsfu (Cloudflare Realtime SFU).
--
-- Uma linha por mes (`yearMonth` = 'YYYY-MM' em UTC), com o total de bytes de
-- egress somado a partir do que cada assinante reporta. Nada de midia aqui --
-- so um contador para o aviso e o bloqueio de cota na UI.
--
-- Sem TTL: o historico mensal e minusculo e vale guardar.

-- CreateTable
CREATE TABLE `CfsfuUsage` (
    `id` VARCHAR(191) NOT NULL,
    `yearMonth` VARCHAR(7) NOT NULL,
    `egressBytes` BIGINT NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CfsfuUsage_yearMonth_key`(`yearMonth`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
