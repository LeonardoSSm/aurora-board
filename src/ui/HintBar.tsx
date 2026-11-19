import { useShallow } from 'zustand/react/shallow';
import { useEditor } from '../store/editor';
import { isLinear } from '../core/schema';

/** Dica contextual sob a barra de ferramentas (como no Excalidraw). */
export function useHint(): string {
  const tool = useEditor((s) => s.tool);
  const editing = useEditor((s) => s.editingTextId);
  const editingGroup = useEditor((s) => s.editingGroupId);
  const drafting = useEditor((s) => s.linearDraftId);
  const selectedPoint = useEditor((s) => s.selectedPointIndex);
  const selected = useEditor(useShallow((s) => {
    const set = new Set(s.selectedIds);
    return s.elements.filter((e) => set.has(e.id));
  }));

  if (editing) return 'Esc ou Ctrl+Enter para confirmar o texto';
  if (drafting) return 'Clique para adicionar pontos · clique no último ponto, Enter ou Esc para finalizar · clique numa forma para conectar';
  switch (tool) {
    case 'hand': return 'Arraste para navegar · Esc volta à seleção';
    case 'rectangle': case 'ellipse': case 'diamond':
      return 'Arraste para desenhar · Shift mantém proporção · Alt desenha a partir do centro · Q mantém a ferramenta';
    case 'arrow': case 'line':
      return 'Clique para criar pontos (curva) ou arraste para uma seta simples · comece/termine sobre formas para conectar · Shift: 15°';
    case 'connect': return 'Arraste de um elemento até outro · escolha o tipo da conexão acima';
    case 'freedraw': return 'Desenhe livremente · a ferramenta continua ativa · Esc volta à seleção';
    case 'text': return 'Clique para escrever · clique numa forma para escrever dentro dela';
    case 'eraser': return 'Clique ou arraste sobre os elementos para apagar';
    case 'sticky': return 'Clique para posicionar a nota e comece a digitar';
    case 'frame': return 'Arraste para criar uma área · o que estiver dentro se move junto';
  }
  if (editingGroup) return 'Editando grupo · clique fora ou Esc para sair';
  if (!selected.length) return 'Arraste no fundo para selecionar · Espaço+arrastar ou botão do meio navega · Duplo clique cria texto';
  if (selected.length === 1) {
    const el = selected[0];
    if (el.locked) return 'Elemento bloqueado · Ctrl+Shift+L desbloqueia';
    if (isLinear(el)) return selectedPoint !== null ? 'Delete remove o ponto selecionado · arraste para mover · Shift: 15°' : 'Arraste os pontos · arraste ◦ entre pontos para criar um novo · clique num ponto e Delete remove · duplo clique: rótulo';
    if (el.type === 'widget') return 'Selecionado: o conteúdo fica interativo (selecionar texto, rolar) · mova pelo cabeçalho · duplo clique no título renomeia';
    if (['rectangle', 'ellipse', 'diamond', 'sticky'].includes(el.type)) return 'Enter para escrever · Ctrl+setas cria um fluxo conectado · Alt+setas navega · Alt+arrastar duplica';
    return 'Alt+arrastar duplica · Shift ao redimensionar mantém proporção';
  }
  const grouped = selected.every((e) => e.groupIds.length && e.groupIds[e.groupIds.length - 1] === selected[0].groupIds[selected[0].groupIds.length - 1]);
  if (grouped) return 'Grupo · duplo clique entra no grupo · Ctrl+Shift+G desagrupa';
  return 'Ctrl+G agrupa · Shift+clique adiciona ou remove · Ctrl durante o arrasto liga/desliga as guias';
}

export function HintBar() {
  const hint = useHint();
  return (
    <div data-testid="hint" className="text-[11px] text-soft text-center px-3 select-none pointer-events-none truncate max-w-full">
      {hint}
    </div>
  );
}
