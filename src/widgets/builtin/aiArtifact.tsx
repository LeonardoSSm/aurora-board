import { useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { MAX_ARTIFACT_HTML, artifactPorts, type ArtifactPorts } from '../../core/artifact';
import { isWidget, type AuroraElement } from '../../core/schema';
import { sanitizeAI, type AIData, type AIMessage } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import { artifactEndpoint, artifactSelection, buildArtifactPlan, MAX_ARTIFACT_ENDPOINTS, parseArtifactProposal } from '../../integrations/artifactActions';
import { artifactScopeFor, discardArtifactProposal, sendAIMessage } from '../../integrations/aiChat';
import type { ProviderInfo } from '../../integrations/aiClient';
import { proposalKey } from '../../integrations/aiActions';
import { Badge, Button, Select } from '../../ui/primitives';
import type { WidgetProps } from '../registry';

const CODE_CLASS = 'max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-panel-3 p-2 font-mono text-[11px]';

export function ArtifactComposer({ aiId, elements, selectedIds, prompt, provider, ready, onSent }: {
  aiId: string;
  elements: AuroraElement[];
  selectedIds: string[];
  prompt: string;
  provider: ProviderInfo | undefined;
  ready: boolean;
  onSent: () => void;
}) {
  const [targetId, setTargetId] = useState(() => elements.find((e) => selectedIds.includes(e.id) && isWidget(e) && e.widgetType === WIDGET.sandbox)?.id ?? '');
  const [endpoints, setEndpoints] = useState<string[]>([]);
  const [approved, setApproved] = useState('');
  const [sending, setSending] = useState(false);
  const target = targetId ? artifactSelection(elements, targetId) : null;
  const choices = useMemo(() => elements.filter(isWidget).flatMap((e) => {
    const endpoint = artifactEndpoint(e);
    return endpoint ? [endpoint] : [];
  }), [elements]);
  const chosen = choices.filter((x) => endpoints.includes(x.id) && x.id !== targetId);
  const send = async () => {
    if (sending || !ready || !provider || !prompt.trim() || (targetId && (!target || approved !== target.configuration))) return;
    setApproved('');
    setSending(true);
    try {
      const sent = await sendAIMessage(aiId, prompt, 'structure', {
        target: target ? { id: target.el.id, configuration: target.configuration } : null,
        endpoints: chosen,
        provider: provider.id,
      });
      if (sent) onSent();
    } finally {
      setSending(false);
    }
  };
  return (
    <section className="flex max-h-52 shrink-0 flex-col gap-2 overflow-auto rounded-lg border border-accent-2/40 bg-panel-2 p-2 text-[11px]" data-scrollable data-testid="artifact-composer">
      <label className="flex flex-col gap-1">
        Painel
        <Select value={targetId} onChange={(e) => { setApproved(''); setTargetId(e.target.value); }}>
          <option value="">Novo Artifact</option>
          {elements.filter((e) => isWidget(e) && e.widgetType === WIDGET.sandbox && !e.locked).map((e) => <option key={e.id} value={e.id}>{(e as { title: string }).title}</option>)}
        </Select>
      </label>
      {targetId && !target && <p className="text-warn">O painel mudou, está bloqueado ou excede {MAX_ARTIFACT_HTML.toLocaleString('pt-BR')} caracteres.</p>}
      {target && (
        <div>
          <div>Código e portas da revisão selecionada para este envio</div>
          <pre className={CODE_CLASS} data-scrollable data-testid="artifact-send-source">{target.data.html}</pre>
          <PortList data={target.data.bridge} />
          <label className="flex items-start gap-1.5">
            <input type="checkbox" className="mt-0.5" checked={approved === target.configuration} onChange={(e) => setApproved(e.target.checked ? target.configuration : '')} />
            Autorizo enviar este código e estas portas a {provider?.name ?? 'o provedor selecionado'}.
          </label>
        </div>
      )}
      <details>
        <summary data-interactive className="cursor-pointer">Blocos para conectar · {chosen.length}/{MAX_ARTIFACT_ENDPOINTS}</summary>
        <p className="my-1 text-muted">Inclui nomes, IDs e portas dos blocos escolhidos. Os valores ficam no quadro.</p>
        {choices.filter((e) => e.id !== targetId).map((e) => (
          <label key={e.id} className="flex items-start gap-1.5">
            <input type="checkbox" className="mt-0.5" checked={endpoints.includes(e.id)} disabled={!endpoints.includes(e.id) && endpoints.length >= MAX_ARTIFACT_ENDPOINTS} onChange={(event) => setEndpoints((ids) => event.target.checked ? [...ids, e.id] : ids.filter((id) => id !== e.id))} />
            <span className="min-w-0 break-words">{e.title} <span className="text-soft">· {e.inputs.length} entradas · {e.outputs.length} saídas</span></span>
          </label>
        ))}
      </details>
      <Button variant="primary" data-testid="artifact-generate" disabled={!ready || sending || !prompt.trim() || (!!targetId && (!target || approved !== target.configuration))} onClick={() => void send()}>Gerar proposta</Button>
    </section>
  );
}

function PortList({ data }: { data?: ArtifactPorts }) {
  const ports = artifactPorts(data);
  return (
    <div className="text-muted">
      <div>Entradas · {ports.inputs.map((p) => `${p.label} (${p.id}, ${p.type})`).join(', ') || 'nenhuma'}</div>
      <div>Saídas · {ports.outputs.map((p) => `${p.label} (${p.id}, ${p.type})`).join(', ') || 'nenhuma'}</div>
    </div>
  );
}

function StaticPreview({ html }: { html: string }) {
  const [open, setOpen] = useState(false);
  const markup = useMemo(() => open ? DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['main', 'section', 'header', 'div', 'span', 'h1', 'h2', 'h3', 'p', 'b', 'strong', 'small', 'label', 'output', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br'],
    ALLOWED_ATTR: [],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
  }) : '', [html, open]);
  return <details onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary data-interactive className="cursor-pointer">Prévia estática do conteúdo</summary>
    <div className="mt-1 rounded border border-line bg-panel p-2">
      <div className="mb-1 text-soft">Conteúdo gerado · prévia sem estilos nem execução</div>
      {markup ? <div className="md break-words" dangerouslySetInnerHTML={{ __html: markup }} /> : <span className="text-muted">Este painel monta a interface ao executar.</span>}
    </div>
  </details>;
}

export function ArtifactProposal({ message, props }: { message: AIMessage; props: WidgetProps<AIData> }) {
  const { api, data, element } = props;
  const [review, setReview] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = proposalKey(message.id, 'ai');
  const scope = artifactScopeFor(element.id, message.id);
  const applied = !!data.applied[key];
  const parsed = useMemo(() => parseArtifactProposal(message.content), [message.content]);
  const plan = (run: boolean) => {
    if (!scope || artifactScopeFor(element.id, message.id) !== scope || !parsed.ok) return { ok: false as const, error: 'A proposta não está disponível nesta sessão.' };
    const elements = api.getElements();
    const ai = elements.find((e) => e.id === element.id && isWidget(e));
    if (!ai || !('data' in ai) || !sanitizeAI(ai.data).messages.some((m) => m.id === message.id && m.content === message.content && m.artifact)) {
      return { ok: false as const, error: 'A resposta mudou durante a revisão.' };
    }
    return buildArtifactPlan(parsed.actions, scope, elements, element.id, key, run);
  };
  const preview = review && !applied && !discarded && scope && parsed.ok ? plan(false) : null;
  const apply = async (run: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const before = plan(run);
      if (!before.ok) { api.toast(before.error, 'error'); return; }
      const confirm = await api.confirm(
        run ? 'Aplicar e autorizar execução do Artifact?' : 'Salvar revisão do Artifact?',
        [...before.plan.lines, '', run ? 'O JavaScript será executado no sandbox. Consultas de rede pedem autorização por destino.' : 'A revisão ficará pausada até você autorizar a execução no painel.', 'Ctrl+Z desfaz esta alteração.'].join('\n'),
        run ? 'Aplicar e executar' : 'Salvar pausado',
      );
      if (!confirm) return;
      const fresh = plan(run);
      if (!fresh.ok) { api.toast(fresh.error, 'error'); return; }
      if (fresh.plan.effect !== before.plan.effect) { api.toast('O quadro mudou. Revise e confirme de novo.', 'warning'); return; }
      api.applyBatch(fresh.plan.add, fresh.plan.updates, true);
      api.toast(run ? 'Artifact aplicado. Ctrl+Z desfaz.' : 'Revisão salva e pausada.', 'success');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-1.5 rounded-lg border border-accent-2/40 bg-panel-2 p-2 text-[11px]" data-testid="artifact-proposal">
      <div className="flex flex-wrap items-center gap-2"><b>Proposta de Artifact</b><Badge>Contrato v3</Badge></div>
      {applied ? <p role="status">Aplicada. Ctrl+Z desfaz.</p>
        : discarded ? <p role="status">Proposta descartada.</p>
          : !parsed.ok ? <p role="alert" className="text-danger">{parsed.error}</p>
            : !scope ? <p role="status">Proposta expirada. Gere outra revisão para aplicar.</p>
              : <Button onClick={() => setReview((v) => !v)} aria-expanded={review}>{review ? 'Recolher revisão' : 'Revisar código e conexões'}</Button>}
      {preview && !preview.ok && <p role="alert" className="text-warn">{preview.error}</p>}
      {preview?.ok && (
        <div className="flex flex-col gap-1.5" data-testid="artifact-review">
          <ul className="list-inside list-disc break-words">{preview.plan.lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
          <div>Execução em iframe isolado. Rede via corretor do Board com autorização por destino. Alterações revogam autorizações afetadas.</div>
          {preview.plan.current && <details><summary data-interactive className="cursor-pointer">Código e portas atuais</summary><PortList data={preview.plan.current.bridge} /><pre className={CODE_CLASS} data-scrollable>{preview.plan.current.html}</pre></details>}
          <PortList data={preview.plan.next.bridge} />
          <StaticPreview html={preview.plan.next.html} />
          <div>Código proposto</div>
          <pre className={CODE_CLASS} data-scrollable data-testid="artifact-proposed-code">{preview.plan.next.html}</pre>
          <div className="flex flex-wrap gap-1.5">
            <Button variant="primary" disabled={busy} onClick={() => void apply(true)}>Aplicar e executar…</Button>
            <Button disabled={busy} onClick={() => void apply(false)}>Salvar pausado…</Button>
          </div>
        </div>
      )}
      {scope && !applied && !discarded && <Button disabled={busy} onClick={() => { discardArtifactProposal(element.id, message.id); setDiscarded(true); }}>Descartar proposta</Button>}
    </section>
  );
}
