# Partilha — salas de compartilhamento de tela

MVP de compartilhamento de tela em salas privadas. O frontend usa React, TypeScript e Vite; o backend Node.js mantém salas em memória e faz a sinalização do WebRTC com Socket.IO. O backend não recebe nem grava áudio ou vídeo.

## Rodar localmente

Requer Node.js 20.19.x ou 22.12 ou mais recente (até a série 26).

```sh
npm install
```

Em dois terminais, na raiz do projeto:

```sh
npm run dev:server
```

```sh
npm run dev
```

Abra `http://localhost:5173`. Para usar outro backend, crie `frontend/.env.local` com `VITE_SIGNALING_URL=http://localhost:10000`. O padrão já usa o servidor local na porta 10000.

## Publicar o frontend no GitHub Pages

1. Envie esta pasta para um repositório GitHub e habilite **Settings → Pages → GitHub Actions**.
2. Faça o deploy do backend no Render, usando o `render.yaml`.
3. Em **Settings → Secrets and variables → Actions → Variables**, crie `VITE_SIGNALING_URL` com a URL HTTPS do backend, por exemplo `https://screen-share-signaling.onrender.com`.
4. Faça push para a branch `main`. A action compila e publica o frontend. A URL de um repositório chamado `screen-share` será `https://SEU_USUARIO.github.io/screen-share/`.

O arquivo `frontend/public/404.html` permite abrir e atualizar diretamente os links `/sala/ABC123` no GitHub Pages.

## Publicar o backend no Render

Crie um **Blueprint** no Render apontando para o repositório. O manifesto seleciona Node, compila TypeScript e inicia o servidor na porta fornecida pelo Render. Configure `ALLOWED_ORIGINS` com a origem exata do GitHub Pages, por exemplo `https://SEU_USUARIO.github.io` (sem barra ao final). Para desenvolvimento local, o servidor permite `localhost:5173` e `127.0.0.1:5173` por padrão.

O plano Free do Render suspende o serviço após 15 minutos sem requisições HTTP ou mensagens WebSocket recebidas; despertar pode levar cerca de um minuto. Uma sala também é encerrada quando o servidor reinicia, pois o estado fica em memória. Consulte as [limitações do plano Free](https://render.com/docs/free).

## STUN e TURN

O servidor fornece STUN do Google por padrão. TURN é opcional e pode ser ativado com um serviço Coturn compatível com a API REST de credenciais temporárias. No Render, configure `TURN_URLS` (URLs `turn:`/`turns:` separadas por vírgula) e `TURN_SECRET` (o segredo compartilhado com Coturn). O backend gera credenciais HMAC de curta duração no endpoint `/api/ice-servers`; o segredo nunca é enviado ao frontend. `TURN_CREDENTIAL_TTL_SECONDS` pode controlar a validade, limitada a 24 horas. Sem essas variáveis, a conexão tenta STUN e a comunicação direta.

O projeto não fornece uma infraestrutura TURN hospedada. Para redes que bloqueiam P2P, contrate/configure Coturn ou um provedor TURN e informe suas URLs e segredo no backend. TURN encaminha mídia e pode gerar custos de tráfego.

## Comportamento do MVP

- Códigos de sala aleatórios com seis caracteres; convites expiram após 15 minutos sem participantes, com limpeza periódica. O servidor limita cada sala a 20 conexões e mantém um teto de 2.000 salas reservadas.
- Apelidos limitados a 24 caracteres e eventos de sinalização validados no servidor.
- Uma transmissão de tela por vez. Outras pessoas podem assistir; uma nova transmissão é recusada até a atual parar.
- O botão muda para **Parar de compartilhar** durante a transmissão. Encerrar pela interface do navegador também encerra a transmissão na sala.
- Tela inteira solicita o áudio do sistema; uma aba só envia a faixa de áudio daquela aba quando o navegador a fornece. Para janelas, o app solicita áudio da janela e só encaminha faixas cujo rótulo do navegador identifica explicitamente como **Application Audio** (ou tradução conhecida). Faixas identificadas como áudio do sistema, sem rótulo ou com origem desconhecida são descartadas para impedir vazamento de sons de outros aplicativos; se o navegador não confirmar a origem, a janela é transmitida sem áudio. Alguns sistemas capturam o áudio no nível do processo/aplicativo, então outras janelas do mesmo aplicativo podem entrar na faixa; a API não garante isolamento por janela individual.
- A origem é identificada pela superfície reportada pelo navegador. Se a origem não puder ser identificada ou não houver uma faixa segura/separada, o vídeo segue sem áudio e a interface informa o motivo.
- Se o navegador bloquear a reprodução automática, aparece o botão **Ativar áudio da transmissão** ou **Reproduzir transmissão**; é preciso clicar para liberar a reprodução.
- Uma pessoa que entra durante uma transmissão recebe uma conexão WebRTC do participante que está compartilhando.
- Ao desconectar, o servidor remove a pessoa e atualiza a sala. O cliente tenta reconectar automaticamente.

WebRTC P2P conecta o participante que transmite diretamente a cada espectador. O limite de 20 atende ao grupo alvo, mas quem transmite envia uma cópia da mídia a cada participante; conexões com muitos espectadores ou upload limitado podem ficar instáveis. Migrar para um SFU seria o próximo passo se isso ocorrer.

## Limitações conhecidas

- Captura de tela requer HTTPS (ou `localhost`) e costuma estar disponível apenas em navegadores desktop. Celulares podem entrar e assistir, mas a captura pode não ser suportada pelo sistema/navegador.
- Compartilhar áudio de tela varia por navegador, sistema operacional e origem selecionada na janela nativa de captura.
- O estado das salas não sobrevive ao reinício do backend.
- A verificação em navegadores, redes distintas, celular, 20 participantes e TURN exige publicar/configurar a infraestrutura. O código inclui o suporte, mas não afirma que esses cenários foram exercitados neste ambiente.
- Nomes não são autenticação; qualquer pessoa com o link pode entrar enquanto houver vaga.

## Checagem local do servidor

Com backend ativo no segundo terminal, execute:

```sh
npm run smoke:server
```

Esse comando verifica health check, CORS, STUN, criação e limite de salas, código inexistente, limite de 20 participantes, transmissão exclusiva, encaminhamento de sinalização, parada e desconexão. Não substitui os testes de mídia real em navegadores e redes diferentes listados abaixo.

## Build local

```sh
npm run build
```
