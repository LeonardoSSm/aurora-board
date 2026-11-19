/**
 * Configuração de runtime decidida NO BUILD (ciclo S1). Nada aqui pode ser ligado pela URL, pelo
 * localStorage ou pelo conteúdo de um quadro: são constantes embutidas pelo Vite.
 *
 * - Desenvolvimento (`npm run dev`): servidor local de IA/links disponível; ganchos de teste expostos.
 * - Build de produção padrão (`npm run build`): **frontend estático** — sem `/api`, sem `window.__aurora`.
 *   É o build destinado à hospedagem pública.
 * - `VITE_AURORA_LOCAL_API=1`: build de produção que ainda conversa com o servidor local (uso pessoal).
 * - `VITE_AURORA_TEST_HOOKS=1`: build de produção com `window.__aurora` (somente benchmarks/testes locais).
 */
const env = import.meta.env;

/** O servidor local (`/api/ai/*`, `/api/link-preview`) faz parte desta distribuição? */
export const LOCAL_API_ENABLED: boolean = env.DEV || env.VITE_AURORA_LOCAL_API === '1';

/** Expor `window.__aurora` (API interna completa) — nunca no build público padrão. */
export const EXPOSE_TEST_HOOKS: boolean = env.DEV || env.VITE_AURORA_TEST_HOOKS === '1';

/** Mensagem única para recursos que dependem do servidor local quando ele não existe nesta versão. */
export const STATIC_AI_MESSAGE = 'As integrações de IA não estão disponíveis nesta versão pública.';
export const STATIC_LINK_PREVIEW_MESSAGE = 'A pré-visualização de links não está disponível nesta versão pública.';
