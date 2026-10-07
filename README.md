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

## Captura, adaptação e diagnóstico WebRTC

- A captura pede 1280×720 a 30 FPS, com limites de 1920×1080 e 30 FPS para evitar captura 4K/60 desnecessária. São preferências/limites da captura do navegador; cada sistema pode fornecer uma resolução ou cadência menor.
- A prévia de quem transmite usa diretamente o `MediaStream` capturado. O vídeo não passa por canvas, filtros ou cópias para redimensionamento em JavaScript. As faixas de áudio continuam seguindo as regras por origem descritas acima.
- Cada envio de vídeo recebe um teto inicial de até 4 Mbps, dividido por espectador com orçamento de referência de 12 Mbps no total do mesh. A cada 2 segundos o cliente consulta `RTCPeerConnection.getStats()`. Perda, RTT, jitter, estimativa de banda disponível e o motivo de limitação reportado pelo navegador podem reduzir bitrate, resolução e, em condições piores, FPS. A recuperação de qualidade é gradual após amostras estáveis; o controle de congestionamento nativo do WebRTC continua ativo. Esses números são limites iniciais de política, não garantias de bitrate ou de qualidade.
- A negociação de codec permanece com o navegador para evitar impor um codec incompatível ou mais caro para determinado aparelho. O painel mostra o codec e, quando o navegador fornece esse dado, a implementação do encoder e o tempo médio de codificação por quadro. O navegador também escolhe se usa aceleração de hardware; a aplicação não consegue forçá-la de forma portátil.
- Abra uma sala com `?debug=webrtc` no endereço, por exemplo `http://localhost:5173/sala/ABC123?debug=webrtc`, para mostrar o painel somente nessa sessão. Ele exibe conexões, estados ICE/PeerConnection, TX/RX, banda estimada, RTT, jitter, perda, FPS, resolução, contadores de quadros, codec, encoder e adaptação aplicada. Métricas indisponíveis aparecem como `—` porque o suporte varia entre navegadores.
- Se um peer ficar `disconnected` por 5 segundos ou entrar em `failed`, o app tenta uma nova conexão com ICE e renegociação, com espera exponencial e até cinco tentativas. Fechar a sala ou a transmissão cancela temporizadores, conexões e faixas locais.
- A sinalização continua trafegando apenas entrada/saída da sala, SDP e ICE pelo Socket.IO. O servidor não recebe a mídia; áudio e vídeo continuam P2P. Em malha P2P, cada espectador adiciona outra conexão e cópia de envio, então os limites de bitrate reduzem o consumo, mas não substituem um SFU em grupos grandes.

O navegador não oferece uma API web portátil para ler uso total de CPU, GPU, RAM ou VRAM, nem para obrigar codificação por hardware. `qualityLimitationReason`, implementação de encoder e tempo de codificação são indicadores úteis, não telemetria completa do sistema. Para validar desempenho real, compare o painel com o monitor de tarefas do sistema e repita a matriz abaixo em diferentes dispositivos, navegadores e redes. O build e o smoke test do servidor não simulam perda de rede nem codificação de tela real.

### Matriz manual para validar a mídia

Esses cenários ainda precisam ser exercitados em computadores e conexões reais. Use dois participantes em máquinas separadas e abra `?debug=webrtc` em ambas:

1. Em um computador potente, compartilhe monitor e janela a 1080p/30; confirme que a resolução enviada não passa de 1080p e o FPS reportado fica estável perto de 30. O perfil atual limita a captura a 30 FPS; comparar 60 FPS requer uma variante de experimento com outro teto.
2. Em um computador intermediário, compartilhe conteúdo com muito movimento e depois conteúdo estático; observe FPS, resolução, encode por quadro e `qualityLimitationReason`.
3. Em um computador de menor capacidade, verifique o indicador `cpu`, quedas de FPS, estabilidade do áudio e uso de CPU/GPU/RAM no monitor do sistema.
4. Repita com rede rápida, média e instável usando um limitador de tráfego no roteador ou no sistema operacional. Confira se os níveis de adaptação descem sob perda/RTT/jitter e sobem gradualmente após estabilização.
5. Teste separadamente guia, janela e tela inteira com áudio, conferindo que guia e janela seguem as faixas disponíveis/seguras e que tela inteira pode transmitir o áudio do sistema. Registre também navegador, sistema operacional, codec/encoder reportados e quantidade de espectadores.

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
