-- Remove as tabelas exclusivas dos transportes legados P2P e Cloudflare (cfsfu).
-- WebCodecs (vercel-relay) não tinha estado no banco.
DROP TABLE IF EXISTS `PeerSignal`;
DROP TABLE IF EXISTS `CfsfuUsage`;
