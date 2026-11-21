/**
 * H2 — janela de confirmação de acesso à rede de um bloco HTML. Mostra: nome do bloco, destino, método, tipo de
 * informação e o aviso sobre dados recebidos de outros blocos. Com dados protegidos, a confirmação é ESPECÍFICA:
 * lista as fontes e deixa claro que não é a autorização para IA.
 */
import { getState, useEditor } from '../store/editor';
import { openDialog } from '../store/ui';
import { SENSITIVE_LABELS } from './policy';
import { setConsentPrompter, type ConsentAnswer, type ConsentRequest } from './broker';

export async function askNetConsent(r: ConsentRequest): Promise<ConsentAnswer> {
  const sensitive = r.need === 'sensitive';
  const pending = openDialog({
    title: sensitive ? 'Enviar dados protegidos para a internet?' : 'Permitir acesso à internet?',
    wide: true,
    body: <ConsentBody r={r} />,
    buttons: [
      { label: 'Negar', value: 'deny', variant: 'ghost' },
      { label: 'Permitir uma vez', value: 'once', variant: 'ghost' },
      { label: 'Permitir sempre neste dispositivo', value: 'always', variant: sensitive ? 'danger' : 'primary' },
    ],
  });
  // Ninguém mais espera (bloco fechado, consultas canceladas): fecha a janela desta confirmação.
  const id = getState().dialog?.id;
  const onAbort = () => { const d = getState().dialog; if (d && d.id === id) d.resolve({ button: null, value: '' }); };
  r.signal.addEventListener('abort', onAbort, { once: true });
  let unsubscribe = () => {};
  try {
    const button = await new Promise<string | null>((resolve) => {
      void pending.then((res) => resolve(res.button));
      // Outra janela do app tomou o lugar desta (há uma só por vez): conta como “fechada sem permitir”, para a
      // fila de confirmações não ficar presa. O atraso deixa a resposta normal (que também fecha a janela) vencer.
      unsubscribe = useEditor.subscribe((s) => { if (s.dialog?.id !== id) setTimeout(() => resolve(null), 0); });
    });
    return button === 'deny' || button === 'once' || button === 'always' ? button : null;
  } finally {
    unsubscribe();
    r.signal.removeEventListener('abort', onAbort);
  }
}

function ConsentBody({ r }: { r: ConsentRequest }) {
  const host = r.origin.replace(/^https:\/\//, '');
  const sensitive = r.need === 'sensitive';
  return (
    <div className="flex flex-col gap-2 text-[12px] text-muted leading-relaxed" data-testid="net-consent">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-lg border border-line/70 bg-[#0f1826] p-2.5">
        <dt className="text-soft">Bloco</dt><dd className="text-fg font-semibold min-w-0 break-words" data-testid="net-consent-widget">{r.title}</dd>
        <dt className="text-soft">Destino</dt><dd className="text-fg font-mono min-w-0 break-all" data-testid="net-consent-origin">{r.origin}</dd>
        <dt className="text-soft">Método</dt><dd className="text-fg">{r.method} — somente leitura (sem envio de corpo, sem cookies, sem credenciais)</dd>
        <dt className="text-soft">Informação</dt><dd>Respostas JSON ou texto UTF-8 de <b className="text-fg">{host}</b>, entregues só a este bloco.</dd>
      </dl>
      <p data-testid="net-consent-inputs">
        {r.inputs.length
          ? <>Este bloco recebe dados de: <b className="text-fg">{r.inputs.join(', ')}</b>. O endereço consultado (caminho e parâmetros) pode carregar dados recebidos de outros blocos para {host}.</>
          : <>Este bloco não tem entradas conectadas agora. Se você conectar outros blocos depois, a autorização deixa de valer e será pedida de novo.</>}
      </p>
      {sensitive && (
        <div className="rounded-lg border border-danger/60 bg-danger/10 p-2.5 text-fg-2" data-testid="net-consent-sensitive">
          <b className="text-danger">Dados protegidos.</b> Este bloco recebe (ou guardou no estado):
          <ul className="list-disc pl-5 my-1">
            {r.sensitive.map((s) => <li key={s.id}><b className="text-fg">{s.title || s.id}</b> — {SENSITIVE_LABELS[s.kind]}</li>)}
          </ul>
          Permitir autoriza que informações derivadas dessas fontes possam sair para <b className="text-fg">{host}</b>. Isto é diferente da autorização para IA e vale só para estas fontes e este destino.
        </div>
      )}
      <p className="text-[11px] text-soft">“Permitir sempre” fica só neste navegador (não vai para quadros, backups ou exportações) e cai se o HTML, as conexões ou as fontes mudarem. Revogue em Propriedades → Acesso à rede.</p>
    </div>
  );
}

setConsentPrompter(askNetConsent);
