# Privacidade e proteção dos dados financeiros

## Onde ficam os dados

- No IndexedDB `aurora-finance` **deste navegador/perfil**, separado do banco dos quadros (`aurora-board`). Nenhum servidor recebe os dados.
- **Não há criptografia própria do armazenamento local.** A proteção efetiva é a do usuário do sistema operacional, do perfil do navegador e da criptografia de disco (BitLocker/FileVault/LUKS), se ativada. Qualquer pessoa ou programa com acesso ao seu perfil do navegador lê esses dados. Um cofre que cifre o IndexedDB foi avaliado e **não** foi implementado neste ciclo: o canvas consulta o razão de forma síncrona, o que exigiria manter a chave aberta em memória durante toda a sessão — uma proteção parcial que daria falsa segurança. Fica como evolução (ver relatório final).
- Números de conta e cartão: só os 4 últimos dígitos (`•••• 1234`), inclusive quando vêm de OFX, provedor ou backup.
- Senhas bancárias, códigos SMS/OTP e tokens **nunca** são pedidos nem guardados. Registros de consentimento guardam só identificadores opacos e escopos de leitura.

## Separação entre quadros e finanças

| O que | Contém dados financeiros? |
|---|---|
| Backup visual (Exportar → Este quadro / Backup do workspace) | **Não.** Blocos de consulta guardam só a consulta (contas por id local, métrica, categoria, período, apresentação) |
| Imagem PNG/SVG do quadro | Só o que está visível (o valor mostrado no bloco) |
| Backup financeiro | Sim — contas e movimentações escolhidas; aviso antes de gerar; cifra opcional |
| Backup pessoal completo | Sim — quadros + finanças, operação explícita; cifra opcional |
| Conversas do Assistente IA | Ficam no quadro (como antes). Se a IA citar valores, eles aparecem no histórico da conversa — limpe a conversa antes de compartilhar um quadro |

Em outro navegador, um bloco de consulta mostra “Referência indisponível” — nunca um valor inventado.

## Backups cifrados

- AES-GCM 256 bits; chave derivada da senha por PBKDF2-SHA-256 com 600.000 iterações; sal aleatório de 16 bytes e IV de 12 bytes por arquivo (Web Crypto). Nada de criptografia própria.
- A senha não é guardada. **Sem a senha o arquivo é irrecuperável.** Senha mínima: 10 caracteres.
- Senha errada e arquivo alterado produzem o mesmo erro (“Senha incorreta ou arquivo corrompido”).
- Restaurar só **acrescenta** registros que ainda não existem; nada é sobrescrito. O arquivo é validado campo a campo (valores, datas, moedas, ids, vínculos).
- Consentimentos e autorizações de IA não entram em backups.

## IA

Nenhum dado bancário é enviado automaticamente — nem por conectar um bloco ao Assistente, nem por dados derivados (um Mês ou Fórmula alimentados por uma consulta bancária também ficam bloqueados).

1. No painel do bloco **Consulta bancária**, escolha *Nada* (padrão), *Resumo agregado* (preferencial: totais, categorias, meses) ou *Movimentações* (até N, com campos escolhidos: datas, descrições, categorias, nomes de contas).
2. A prévia mostra **exatamente** o texto que será enviado.
3. **Autorizar este conteúdo para IA** + confirmação.
4. A autorização fica no razão **deste navegador**, ligada ao bloco e à configuração exata. Mudar a consulta, duplicar o bloco, importar o quadro em outro lugar ou trocar de navegador exige nova confirmação; um quadro manipulado não traz autorização válida.

Proteções do texto: descrições são tratadas como **dados não confiáveis** (o modelo é avisado; ficam entre aspas, sem marcação, com números de 5+ dígitos e e-mails mascarados, limitadas a 60 caracteres); movimentações aparecem com referências opacas (`t_…`), nunca ids internos, números de conta ou consentimentos; teto de 6.000 caracteres por bloco.

A IA pode **sugerir categorias** (`"categorize": [{"ref":"t_…","category":"…"}]`): só para referências que foram enviadas e para categorias que já existem; o cartão de sugestões exige revisão e confirmação; a mudança vai para a classificação local. A IA não executa nenhuma ação financeira real (não há operação de pagamento/transferência em nenhum ponto do sistema).

## Logs e erros

O módulo financeiro não registra nada no console. Mensagens de erro de armazenamento são genéricas; erros de leitura de arquivo citam no máximo 30 caracteres do campo problemático, só na tela.

## Apagar

“Privacidade e backups → Apagar todos os dados financeiros” (confirmação digitada `APAGAR`) zera o razão local. Não revoga autorizações em instituições externas.
