# S1 — Modelo de ameaça

## Ativos

| Ativo | Onde vive | Por que importa |
|---|---|---|
| Conteúdo dos quadros (texto, finanças, documentos, imagens) | IndexedDB `aurora-board` da origem do app | Dado pessoal do usuário; não existe cópia no servidor |
| Diário de recuperação | `localStorage` (`aurora-board-journal:*`) | Cópia em texto do último estado não salvo |
| Integridade/disponibilidade do armazenamento | IndexedDB, autosave | Um quadro "envenenado" pode impedir salvar ou exportar backups |
| Créditos de IA | chaves em `.env` do servidor local | Custo financeiro direto |
| Rede interna do usuário | alcançável pelo servidor local | Alvo de SSRF via pré-visualização de links |
| Reputação/confiança visual | UI do app | Phishing dentro do quadro |

## Fronteiras de confiança

```
 arquivo importado / colado / soltado ──┐
 site visitado (outra aba) ─────────────┤
                                        ▼
            ┌──────────── origem do app (https://host) ─────────────┐
            │ React + store + IndexedDB + localStorage              │
            │   ├─ iframe sandbox (origem opaca)  ← HTML de widgets │
            │   ├─ <img> data:/blob:              ← imagens          │
            │   └─ iframe/link blob: (MESMA origem!) ← documentos    │
            └────────────────────────┬──────────────────────────────┘
                                     │ /api (somente dev local, proxy Vite)
                                     ▼
                     servidor Node 127.0.0.1:8787 ──► provedores de IA / sites (link preview)
```

O ponto crítico: **`blob:` e `srcdoc` sem sandbox herdam a origem do app.** Qualquer conteúdo do usuário que vire
documento ativo nessas URLs tem os mesmos poderes do código do Aurora Board.

## Modelos

### A — aplicação local (`npm run dev`)
- Atacante: autor de um arquivo (backup, imagem, documento) ou de um site visitado.
- Não está no modelo: outro usuário/processo da mesma máquina (já tem acesso ao `.env` e ao perfil do navegador).
- Riscos: execução na origem (documentos), gasto de IA via CSRF/DNS rebinding, SSRF, DoS por importação,
  vizinho de rede se o dev server for exposto (`--host`).

### B — frontend público estático (beta)
- Igual ao A, **sem** servidor (nenhum `/api`), sem contas, sem sincronização.
- Não há "dados de outros usuários" no servidor: o atacante precisa fazer a vítima **abrir conteúdo** dele.
- Riscos adicionais: configuração da hospedagem (CSP, headers, cache, arquivos expostos), dependências
  carregadas no navegador, rastreamento por recursos externos embutidos em quadros importados.

### C — backend acessível externamente (não autorizado neste ciclo)
- Sem autenticação, qualquer cliente que alcance a API usa as chaves do dono.
- Exigiria outro ciclo: identidade, autorização por recurso, cotas e limites financeiros por usuário, rate limit
  distribuído, isolamento de dados, observabilidade, proteção contra abuso, auditoria de infraestrutura.

## Classificação de gravidade usada

- **P0** execução na origem principal, exfiltração, comprometimento grave de integridade, exposição de credenciais/serviços pagos.
- **P1** DoS reproduzível em operações comuns, validação insuficiente com impacto significativo, bypass relevante de isolamento.
- **P2** defesa em profundidade, redução de superfície, configurações inadequadas.
- **P3** evolução posterior sem impacto imediato no beta estático.

Cada achado recebe gravidade separada para **local / público estático / backend público** em
[`S1-FINDINGS.md`](S1-FINDINGS.md).
