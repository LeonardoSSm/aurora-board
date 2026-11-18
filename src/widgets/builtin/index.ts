import { GitBranch as Github, HardDrive, CalendarClock, Globe, LineChart, LayoutDashboard, Wrench } from 'lucide-react';
import { registerPlanned, registerWidget } from '../registry';
import { notesPlugin } from './notes';
import { tasksPlugin } from './tasks';
import { financePlugin } from './finance';
import { calendarPlugin } from './calendar';
import { documentsPlugin } from './documents';
import { linkPlugin } from './link';
import { codePlugin } from './code';
import { aiPlugin } from './ai';
import { chartPlugin } from './chart';
import { sandboxPlugin } from './sandbox';

let done = false;

export function registerBuiltinWidgets() {
  if (done) return;
  done = true;
  for (const p of [notesPlugin, tasksPlugin, financePlugin, calendarPlugin, documentsPlugin, linkPlugin, codePlugin, aiPlugin, chartPlugin, sandboxPlugin]) registerWidget(p as never);

  registerPlanned({ id: 'google.calendar', name: 'Google Calendar', description: 'Sincronizar eventos do Google com o bloco Calendário.', icon: CalendarClock, permissions: ['external:google-calendar'], activation: 'Requer OAuth 2.0 (Client ID do Google Cloud) e endpoint no servidor para troca de tokens.' });
  registerPlanned({ id: 'google.drive', name: 'Google Drive', description: 'Referenciar e visualizar arquivos do Drive no bloco Documentos.', icon: HardDrive, permissions: ['external:google-drive'], activation: 'Requer OAuth 2.0 com escopo drive.readonly.' });
  registerPlanned({ id: 'github', name: 'GitHub', description: 'Issues, PRs e status de CI como blocos vivos.', icon: Github, permissions: ['external:github'], activation: 'Requer token/OAuth GitHub guardado no servidor.' });
  registerPlanned({ id: 'http.api', name: 'API externa', description: 'Consultar uma API HTTP e expor o resultado como dados.', icon: Globe, permissions: [], activation: 'Requer proxy no servidor com lista de domínios permitidos.' });
  registerPlanned({ id: 'finance.indicators', name: 'Indicadores financeiros', description: 'Cotações e índices (Selic, IPCA, câmbio).', icon: LineChart, permissions: [], activation: 'Requer fonte de dados (ex.: API do Banco Central) via servidor.' });
  registerPlanned({ id: 'dashboard', name: 'Dashboard', description: 'Painel com múltiplos indicadores conectados.', icon: LayoutDashboard, permissions: [], activation: 'Planejado sobre o motor de fluxo de dados existente.' });
  registerPlanned({ id: 'devtools', name: 'Ferramentas de dev', description: 'Logs, deploys e serviços personalizados.', icon: Wrench, permissions: [], activation: 'Planejado como plugins isolados (manifesto + sandbox).' });
}
