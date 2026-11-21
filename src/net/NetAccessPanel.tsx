/**
 * H2-C — seção “Acesso à rede” do painel de Propriedades de um bloco HTML: estado, destinos autorizados (com
 * método e tipo), revogação individual/total, última consulta (só origem/código/tamanho/tempo — nunca caminho,
 * consulta ou corpo), bloqueios, fontes protegidas e aviso quando esta versão não tem backend de rede.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { WidgetElement } from '../core/schema';
import type { SandboxData } from '../core/widgetData';
import { useEditor } from '../store/editor';
import { Badge, Button, Label } from '../ui/primitives';
import { forgetNetMemory, netActivity, netAvailability, netStatusFor, netVersion, probeNetServer, revokeNetAccess, subscribeNet, type NetServerStatus } from './broker';
import { grantIsCurrent, SENSITIVE_LABELS, type NetGrant } from './policy';
import { NET_ERROR_HINTS, type NetErrorCode } from './protocol';

const time = (t: number) => new Date(t).toLocaleTimeString('pt-BR');
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KB`);
const SERVER_MSG: Record<Exclude<NetServerStatus, 'ok' | 'unknown'>, string> = {
  offline: 'O servidor local do Aurora Board não respondeu: as consultas vão falhar até ele ser iniciado (npm run dev).',
  missing: 'O servidor local desta instalação não oferece acesso à rede para blocos HTML (atualize o Aurora Board).',
  local_only: 'Este computador está pareado com outro: o acesso à rede dos blocos HTML só funciona no computador principal.',
};

export function NetAccessPanel({ element, data, onClearState }: { element: WidgetElement; data: SandboxData; onClearState: () => void }) {
  const grantsAll = useEditor((s) => s.htmlNetGrants);
  const elements = useEditor((s) => s.elements);
  const boardId = useEditor((s) => s.boardId) ?? '';
  const [server, setServer] = useState<NetServerStatus>('unknown');
  const avail = netAvailability();
  useEffect(() => { if (avail.available) void probeNetServer().then(setServer); }, [avail.available]);
  const version = useSyncExternalStore(subscribeNet, netVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const st = useMemo(() => netStatusFor(element.id), [element.id, elements, data, grantsAll, version]);
  const grants = grantsAll.filter((g) => g.elementId === element.id && g.boardId === boardId);
  const act = netActivity(element.id);
  const origins = [...new Set([...grants.map((g) => g.origin), ...st.onceOrigins])].sort();
  const current = (g: NetGrant) => !!st.ctx && grantIsCurrent(g, st.ctx, st.sensitive);
  const anyCurrent = grants.some(current) || st.onceOrigins.length > 0;
  const blockedSens = st.sensitive.some((s) => s.kind === 'missing');
  const state = !avail.available ? 'indisponível' : blockedSens ? 'bloqueado' : act?.pendingConsent ? 'aguardando autorização' : anyCurrent ? 'autorizado' : 'desativado';
  const tone = state === 'autorizado' ? 'ok' : state === 'desativado' ? undefined : 'warn';
  const known = st.sensitive.filter((s) => s.kind !== 'missing');

  return (
    <div className="flex flex-col gap-1.5 text-[11px]" data-testid="net-panel">
      <Label>Acesso à rede</Label>
      <div className="rounded-lg border border-line/60 p-2 bg-[#0f1826] flex flex-col gap-1.5 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-soft">Estado:</span>
          <span data-testid="net-state"><Badge tone={tone}>{state}</Badge></span>
        </div>
        {!avail.available && <div className="text-warn" data-testid="net-unavailable">{avail.message}</div>}
        {avail.available && server !== 'ok' && server !== 'unknown' && <div className="text-warn" data-testid="net-server">{SERVER_MSG[server]}</div>}
        {avail.available && !origins.length && !blockedSens && (
          <div className="text-soft">Nenhum destino autorizado. Quando o HTML chamar <code>aurora.request()</code>, o Aurora Board pergunta antes de consultar (só GET, HTTPS).</div>
        )}

        {(known.length > 0 || blockedSens) && (
          <div className="rounded-md border border-danger/50 bg-danger/10 p-1.5 text-fg-2 flex flex-col gap-1" data-testid="net-sensitive">
            {known.length > 0 && <div>Recebe dados protegidos: {known.map((s) => <b key={s.id} className="text-fg">{s.title || s.id} <span className="font-normal text-soft">({SENSITIVE_LABELS[s.kind]})</span></b>).reduce<ReactNode[]>((acc, x, i) => (i ? [...acc, ', ', x] : [x]), [])}. A rede exige uma autorização específica destas fontes para cada destino.</div>}
            {blockedSens && <div className="text-warn">O estado ou a execução deste bloco recebeu dados de uma fonte protegida que não existe mais: a rede está bloqueada.</div>}
            {(data.stateTaint || blockedSens) && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="min-w-0">O estado guardado veio de uma execução com dados protegidos.</span>
                <Button data-testid="net-clear-state" onClick={() => { onClearState(); forgetNetMemory(element.id); }}>Limpar estado e recarregar</Button>
              </div>
            )}
          </div>
        )}

        {origins.length > 0 && (
          <ul className="flex flex-col gap-1" data-testid="net-destinations">
            {origins.map((o) => {
              const gs = grants.filter((g) => g.origin === o);
              const sens = gs.find((g) => g.kind === 'sensitive');
              const once = st.onceOrigins.includes(o);
              const stale = gs.length > 0 && !gs.some(current) && !once;
              return (
                <li key={o} className="rounded-md border border-line/60 p-1.5 flex flex-col gap-0.5 min-w-0" data-testid="net-destination">
                  <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                    <span className="font-mono text-fg break-all min-w-0 flex-1">{o}</span>
                    <Badge>GET</Badge>
                    <Button aria-label={`Revogar ${o}`} onClick={() => void revokeNetAccess(element.id, o)}>Revogar</Button>
                  </div>
                  <div className="text-soft">
                    {gs.some((g) => g.kind === 'network') ? `Sempre neste dispositivo (desde ${new Date(Math.min(...gs.map((g) => g.at))).toLocaleString('pt-BR')})` : ''}
                    {once ? `${gs.length ? ' · ' : ''}Uma vez (esta execução)` : ''}
                    {sens?.sources?.length ? ` · dados protegidos: ${sens.sources.map((s) => s.title || s.id).join(', ')}` : ''}
                  </div>
                  {stale && <div className="text-warn" data-testid="net-stale">Desatualizada: o HTML, as conexões ou as fontes mudaram. Será pedida de novo.</div>}
                </li>
              );
            })}
          </ul>
        )}
        {origins.length > 1 && <Button data-testid="net-revoke-all" onClick={() => void revokeNetAccess(element.id)}>Revogar todos os acessos</Button>}
        {origins.length === 1 && <Button data-testid="net-revoke-all" onClick={() => void revokeNetAccess(element.id)}>Revogar acesso</Button>}

        <div className="text-soft" data-testid="net-last">
          Última consulta:{' '}
          {act?.last ? (
            act.last.ok
              ? <>{act.last.status} · {act.last.origin.replace('https://', '')} · {kb(act.last.bytes ?? 0)} · {act.last.ms} ms · {time(act.last.at)}</>
              : <span className="text-warn">{act.last.code}{act.last.status ? ` ${act.last.status}` : ''} · {act.last.origin.replace('https://', '')} · {time(act.last.at)}</span>
          ) : 'nenhuma'}
        </div>
        <div className="text-soft" data-testid="net-blocked">
          Bloqueadas: {act?.blocked ?? 0}{act?.lastBlocked ? ` (última: ${act.lastBlocked.code}${act.lastBlocked.origin ? ` · ${act.lastBlocked.origin.replace('https://', '')}` : ''} · ${time(act.lastBlocked.at)}${NET_ERROR_HINTS[act.lastBlocked.code as NetErrorCode] ? ` — ${NET_ERROR_HINTS[act.lastBlocked.code as NetErrorCode]}` : ''})` : ''}
        </div>
        <div className="text-[10px] text-soft">Só GET para HTTPS, pelo servidor local; sem cookies, credenciais ou cabeçalhos do HTML. O histórico guarda só o destino, nunca o endereço completo nem o conteúdo. Ver docs/HTML_NETWORK_BRIDGE.md.</div>
      </div>
    </div>
  );
}
