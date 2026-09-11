/**
 * TEMPORÁRIO: função de nome comum que só reexporta o handler do Nest,
 * igual ao `[...nest].ts`, para separar "nome do arquivo" de "conteúdo".
 */
import handler from '../apps/api/dist/src/vercel.js';

export default handler;
