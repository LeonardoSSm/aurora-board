/**
 * Aurora Wheel (issue #15): roda cinza translúcida de criação. Vetorial (SVG + botões HTML): clique preciso por
 * ângulo, sem bitmap. Abre pelo gesto (segurar o botão direito em área vazia), pelo atalho W ou pelo botão
 * “Criar” da barra. Teclado: setas/Tab circulam, Enter/Espaço ativam, 1–8 escolhem direto, Esc volta/fecha.
 * Menu tradicional, diálogos e atalhos continuam iguais: a roda é um caminho a mais, nunca o único.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { ArrowLeft, ImageIcon, Search, Settings2, X } from 'lucide-react';
import { useEditor, getState, setState } from '../store/editor';
import { RADIAL_GEOMETRY as G, sectorAngle, sectorAt, sectorPath, type RadialItemId } from '../core/radial';
import { closeRadial, setRadialSelectHandler, setRadialSliceCount } from '../canvas/radialGesture';
import { BUILTIN_ITEMS, SUB_ITEMS, availableWidgets, radialItemDef, runRadialItem, type RadialItemDef } from '../store/radialActions';
import { pickImages } from '../store/actions';
import { presetDragType } from '../widgets/registry';

const SIZE = (G.outer + 22) * 2;
/** Busca sem acento nem caixa. */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const LABEL_R = (G.inner + G.outer) / 2 + 4;

function ringItems(sub: 'shape' | 'connector' | 'more' | null, favorites: RadialItemId[]): RadialItemDef[] {
  if (sub === 'shape' || sub === 'connector') return SUB_ITEMS[sub];
  return favorites.map((id) => radialItemDef(id)).filter((d): d is RadialItemDef => !!d);
}

export function RadialMenu() {
  const radial = useEditor((s) => s.radial);
  const favorites = useEditor((s) => s.radialFavorites);
  const items = useMemo(() => ringItems(radial?.sub ?? null, favorites), [radial?.sub, favorites]);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const activate = (def: RadialItemDef | undefined) => {
    const r = getState().radial;
    if (!def || !r) return;
    if (def.sub) { setState({ radial: { ...r, sub: def.sub, hover: r.source === 'keyboard' ? 0 : null } }); return; }
    closeRadial();
    runRadialItem(def.id, r.world);
  };

  // A máquina de estados do gesto chama isto ao soltar sobre uma fatia.
  useEffect(() => {
    setRadialSliceCount(items.length);
    setRadialSelectHandler((index) => activate(items[index]));
    return () => setRadialSelectHandler(null);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Foco: a roda recebe o foco ao abrir (teclado funciona mesmo após abrir pelo mouse) e devolve ao fechar.
  const open = !!radial;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    rootRef.current?.focus({ preventScroll: true });
    const onBlur = () => closeRadial();
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      // Devolve o foco só se ninguém o pegou (ex.: Nota/Texto abrem o editor, que não pode perder o foco).
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (a && a !== document.body) return;
        if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
        else (document.querySelector('[data-testid="canvas"]') as HTMLElement | null)?.focus({ preventScroll: true });
      });
    };
  }, [open]);

  // Item ativo pelo teclado recebe o foco real (leitores de tela anunciam o nome).
  useEffect(() => {
    if (radial?.source === 'keyboard' && radial.hover !== null && radial.sub !== 'more') itemRefs.current[radial.hover]?.focus({ preventScroll: true });
  }, [radial?.hover, radial?.source, radial?.sub]);

  if (!radial) return null;
  const n = items.length;
  const hover = radial.hover;
  const left = radial.center.x - SIZE / 2, top = radial.center.y - SIZE / 2;
  const back = () => setState({ radial: { ...radial, sub: null, hover: radial.source === 'keyboard' ? 0 : null } });
  const cancelOrBack = () => (radial.sub ? back() : closeRadial());

  const onKeyDown = (e: RKeyboardEvent) => {
    e.stopPropagation(); // atalhos do quadro não disparam com a roda aberta
    if (e.key === 'Escape') { e.preventDefault(); cancelOrBack(); return; }
    if (radial.sub === 'more') return; // a lista trata o próprio teclado
    const cur = hover ?? -1;
    const go = (i: number) => setState({ radial: { ...radial, source: 'keyboard', hover: ((i % n) + n) % n } });
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); go(cur + 1); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) { e.preventDefault(); go(cur < 0 ? n - 1 : cur - 1); return; }
    if (e.key === 'Home') { e.preventDefault(); go(0); return; }
    if (e.key === 'End') { e.preventDefault(); go(n - 1); return; }
    if ((e.key === 'Enter' || e.key === ' ') && hover !== null) { e.preventDefault(); activate(items[hover]); return; }
    if (e.key === 'Backspace' && radial.sub) { e.preventDefault(); back(); return; }
    const digit = Number(e.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= n) { e.preventDefault(); activate(items[digit - 1]); }
  };

  // Depois de solto o botão (modo clique), a fatia segue o ponteiro e o clique escolhe.
  const local = (e: { clientX: number; clientY: number }) => ({ x: e.clientX - radial.center.x, y: e.clientY - radial.center.y });
  const onPointerMove = (e: RPointerEvent) => {
    if (radial.sub === 'more') return;
    const i = sectorAt(local(e), n);
    if (i !== hover || radial.source !== 'pointer') setState({ radial: { ...radial, hover: i, source: 'pointer' } });
  };
  const onWheelClick = (e: React.MouseEvent) => {
    const d = local(e);
    if (Math.hypot(d.x, d.y) < G.inner) { cancelOrBack(); return; }
    const i = sectorAt(d, n);
    if (i !== null) activate(items[i]);
  };

  const title = radial.sub === 'shape' ? 'Forma' : radial.sub === 'connector' ? 'Conexão' : 'Criar';
  return (
    <div
      className="fixed inset-0 z-[70]"
      data-testid="radial-backdrop"
      onPointerDown={(e) => { if (e.target === e.currentTarget) closeRadial(); }}
      onContextMenu={(e) => { e.preventDefault(); if (e.target === e.currentTarget) closeRadial(); }}
    >
      <div
        ref={rootRef}
        role="menu"
        aria-label={`${title} — Aurora Wheel`}
        aria-describedby="radial-help"
        tabIndex={-1}
        data-testid="radial-menu"
        data-sub={radial.sub ?? 'main'}
        className="radial-open absolute outline-none"
        style={{ left, top, width: SIZE, height: SIZE }}
        onKeyDown={onKeyDown}
        onPointerMove={onPointerMove}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      >
        <span id="radial-help" className="sr-only">Setas escolhem, Enter cria no ponto clicado, números de 1 a {n} escolhem direto, Esc {radial.sub ? 'volta' : 'fecha'}.</span>
        {radial.sub === 'more' ? (
          <MorePanel world={radial.world} onBack={back} />
        ) : (
          <>
            <svg width={SIZE} height={SIZE} viewBox={`${-SIZE / 2} ${-SIZE / 2} ${SIZE} ${SIZE}`} className="absolute inset-0 radial-disc" aria-hidden="true" onClick={onWheelClick}>
              <circle r={G.outer + 6} className="radial-halo" />
              {items.map((it, i) => (
                <path key={it.id} d={sectorPath(i, n, G.inner + 2, G.outer)} data-index={i} className={`radial-slice ${hover === i ? 'is-active' : ''}`} />
              ))}
              <circle r={G.inner - 2} className="radial-center" />
            </svg>
            {items.map((it, i) => {
              const a = sectorAngle(i, n);
              const x = SIZE / 2 + LABEL_R * Math.sin(a), y = SIZE / 2 - LABEL_R * Math.cos(a);
              const Icon = it.icon;
              return (
                <button
                  key={it.id}
                  ref={(el) => { itemRefs.current[i] = el; }}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  aria-label={`${it.label}: ${it.hint}`}
                  aria-haspopup={it.sub ? 'menu' : undefined}
                  title={`${i + 1}. ${it.hint}`}
                  data-testid="radial-item"
                  data-id={it.id}
                  data-active={hover === i ? 'true' : 'false'}
                  className={`radial-item absolute flex flex-col items-center gap-0.5 -translate-x-1/2 -translate-y-1/2 w-[64px] text-center ${hover === i ? 'text-white' : 'text-[#d6dde8]'}`}
                  style={{ left: x, top: y }}
                  onClick={(e) => { e.stopPropagation(); activate(it); }}
                  onPointerEnter={() => setState({ radial: { ...radial, hover: i, source: 'pointer' } })}
                >
                  <Icon size={18} strokeWidth={1.8} />
                  <span className="text-[10px] font-semibold leading-tight">{it.label}</span>
                </button>
              );
            })}
            <button
              type="button"
              data-testid="radial-center"
              aria-label={radial.sub ? 'Voltar à roda principal' : 'Cancelar'}
              title={radial.sub ? 'Voltar (Esc)' : 'Cancelar (Esc)'}
              className="absolute grid place-items-center rounded-full text-[10px] font-semibold text-[#c7d0dd] hover:text-white"
              style={{ left: SIZE / 2 - G.inner + 4, top: SIZE / 2 - G.inner + 4, width: (G.inner - 4) * 2, height: (G.inner - 4) * 2 }}
              onClick={(e) => { e.stopPropagation(); cancelOrBack(); }}
            >
              {radial.sub ? <ArrowLeft size={16} /> : <span className="flex flex-col items-center leading-none"><span>{title}</span><X size={11} className="mt-0.5 opacity-70" /></span>}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** “Mais”: lista compacta e pesquisável de todos os widgets e variações (inclui Consulta bancária, HTML, Fórmula, Gráfico). */
function MorePanel({ world, onBack }: { world: { x: number; y: number }; onBack: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const entries = useMemo(() => {
    const out: { id: string; label: string; group: string; icon: RadialItemDef['icon']; search: string }[] = [];
    out.push({ id: 'image', label: 'Imagem', group: 'Mídia', icon: ImageIcon, search: 'imagem foto mídia' });
    for (const w of availableWidgets()) {
      if (!w.hideInLibrary) out.push({ id: `widget:${w.id}`, label: w.name, group: w.category, icon: w.icon as RadialItemDef['icon'], search: `${w.name} ${w.category} ${w.description}` });
      for (const p of w.presets ?? []) out.push({ id: `preset:${presetDragType(w.id, p.id)}`, label: p.name, group: w.librarySection ?? w.name, icon: w.icon as RadialItemDef['icon'], search: [p.name, p.description ?? '', ...(p.keywords ?? []), w.name, w.librarySection ?? ''].join(' ') });
    }
    for (const b of Object.values(BUILTIN_ITEMS)) if (!b.sub && !out.some((o) => o.label === b.label)) out.unshift({ id: b.id, label: b.label, group: 'Rápidos', icon: b.icon, search: `${b.label} ${b.hint}` });
    return out;
  }, []);
  const filter = (raw: string) => {
    const nd = fold(raw.trim());
    if (!nd) return entries;
    const terms = nd.split(/\s+/);
    // Relevância: rótulo começando pela busca > rótulo contendo > grupo/descrição. Ordem estável no empate.
    const score = (e: (typeof entries)[number]) => {
      const label = fold(e.label);
      if (!terms.every((t) => fold(`${e.label} ${e.group} ${e.search}`).includes(t))) return -1;
      if (label.startsWith(nd)) return 3;
      if (terms.every((t) => label.includes(t))) return 2;
      return fold(e.group).includes(nd) ? 1 : 0;
    };
    return entries.map((e, i) => ({ e, i, s: score(e) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.e);
  };
  const list = filter(q);
  const run = (id: string) => {
    closeRadial();
    if (id === 'image') void pickImages(world);
    else runRadialItem(id, world);
  };
  const cur = Math.min(active, Math.max(0, list.length - 1));
  return (
    <div className="absolute inset-2 radial-panel rounded-2xl flex flex-col overflow-hidden" data-testid="radial-more" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1 p-1.5 border-b border-white/10">
        <button type="button" aria-label="Voltar à roda" className="p-1 rounded-md hover:bg-white/10" onClick={onBack}><ArrowLeft size={14} /></button>
        <label className="flex-1 flex items-center gap-1.5 h-7 px-2 rounded-md bg-black/25">
          <Search size={12} className="text-soft" />
          <input
            autoFocus
            aria-label="Buscar widgets"
            role="combobox"
            aria-expanded="true"
            aria-controls="radial-more-list"
            aria-activedescendant={list[cur] ? `radial-more-${cur}` : undefined}
            value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((cur + 1) % Math.max(1, list.length)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((cur - 1 + list.length) % Math.max(1, list.length)); }
              else if (e.key === 'Enter') {
                // Filtra pelo valor atual do campo (o Enter pode chegar antes do novo render).
                const fresh = filter(e.currentTarget.value);
                const pick = e.currentTarget.value === q ? fresh[cur] : fresh[0];
                if (pick) { e.preventDefault(); run(pick.id); }
              }
            }}
            placeholder="Buscar widget"
            className="bg-transparent outline-none text-[11px] flex-1 min-w-0"
          />
        </label>
      </div>
      <ul id="radial-more-list" role="listbox" aria-label="Widgets" className="flex-1 overflow-y-auto p-1 text-[11px]">
        {list.length === 0 && <li className="px-2 py-2 text-soft">Nada encontrado.</li>}
        {list.map((e, i) => {
          const Icon = e.icon;
          return (
            <li
              key={e.id}
              id={`radial-more-${i}`}
              role="option"
              aria-selected={i === cur}
              data-testid="radial-more-item"
              data-id={e.id}
              className={`flex items-center gap-2 px-2 py-1 rounded-md cursor-pointer ${i === cur ? 'bg-white/15 text-white' : 'text-[#d6dde8] hover:bg-white/10'}`}
              onPointerMove={() => { if (i !== cur) setActive(i); }}
              onClick={() => run(e.id)}
            >
              <Icon size={13} />
              <span className="flex-1 truncate">{e.label}</span>
              <span className="text-[9px] text-soft truncate max-w-[70px]">{e.group}</span>
            </li>
          );
        })}
      </ul>
      <button type="button" className="flex items-center justify-center gap-1 text-[10px] text-soft hover:text-fg py-1.5 border-t border-white/10" onClick={() => { closeRadial(); setState({ selectedIds: [], propertiesOpen: true, tool: 'select' }); setTimeout(() => document.querySelector<HTMLElement>('[data-testid="radial-favorites"]')?.scrollIntoView({ block: 'center' }), 50); }}>
        <Settings2 size={11} /> Personalizar a roda
      </button>
    </div>
  );
}
