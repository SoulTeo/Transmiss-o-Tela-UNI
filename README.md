# Partilha — salas de compartilhamento de janela

Aplicação web para criar salas, convidar participantes e transmitir uma janela ou guia do navegador em tempo real. O frontend usa React, TypeScript e Vite; o backend Node.js mantém presença e sinalização com Socket.IO. Áudio e vídeo trafegam diretamente por WebRTC P2P entre quem compartilha e cada espectador. O backend não recebe nem grava mídia.

## Executar localmente

Requer Node.js 20.19 ou mais recente na série 20, ou 22.12 ou mais recente. Instale as dependências na raiz:

```sh
npm install
```

Em um terminal, inicie o backend de sinalização:

```sh
npm run dev:server
```

Em outro terminal, inicie o frontend:

```sh
npm run dev
```

Abra `http://localhost:5173`. O frontend usa `http://localhost:10000` como servidor Socket.IO em desenvolvimento. Se o backend estiver em outro endereço, defina `VITE_SIGNALING_URL` em `frontend/.env.local`.

## Compartilhamento e áudio

- A captura ocorre no navegador com `getDisplayMedia()` e precisa de HTTPS (ou `localhost`). O seletor é aberto diretamente pelo clique em **Compartilhar janela**.
- A captura pede janela como superfície preferencial e solicita ao navegador uma faixa de áudio da janela. Hints do navegador não garantem que esse áudio exista.
- Se o navegador identificar a origem como monitor/tela inteira, o compartilhamento é recusado. Se não informar a superfície capturada, a aplicação também falha de forma segura e pede uma nova seleção.
- Se a origem for uma guia, o áudio da guia é enviado quando vier na faixa de captura. Para janela de aplicativo, somente uma faixa entregue pela captura e não identificada como áudio do sistema ou microfone é encaminhada. A aplicação não usa `getUserMedia()` nem mistura outra fonte de áudio.
- Se não houver faixa isolada, o vídeo continua sem áudio e a sala mostra o motivo. Navegadores e sistemas operacionais variam; a Web não oferece uma API portátil para capturar o áudio privado de qualquer processo.
- O botão **Parar de compartilhar** e o encerramento pelo seletor nativo param as faixas e encerram a transmissão para todos na sala.
- A prévia usa o `MediaStream` diretamente; não há redesenho em canvas.

## Salas e sinalização

- Códigos de seis caracteres evitam `0`, `O`, `1` e `I`. Salas vazias expiram em 15 minutos. O estado é mantido em memória e desaparece quando o processo reinicia.
- Cada sala aceita até 20 conexões e uma transmissão. Apelidos têm até 24 caracteres. Não há autenticação: quem recebe o código pode entrar enquanto houver vaga.
- Quem compartilha cria um `RTCPeerConnection` para cada espectador. Entradas durante uma transmissão recebem uma offer do transmissor sem precisar atualizar a página.
- Socket.IO encaminha SDP/ICE somente ao participante destinatário, na mesma sala, depois de validar a associação e limitar o tamanho dos payloads. A conexão usa Google STUN por padrão.
- TURN é opcional. Configure `TURN_URLS`, `TURN_SECRET` e `TURN_CREDENTIAL_TTL_SECONDS` no backend para emitir credenciais HMAC de curta duração para um servidor Coturn compatível com REST. A duração é limitada a 24 horas. O segredo nunca vai ao frontend. Sem essas variáveis, o app usa somente STUN; algumas redes podem bloquear conexões P2P.
- Em redes que permitem apenas TURN, o servidor TURN externo encaminha a mídia. Sem TURN, a mídia segue diretamente entre navegadores.
- O bitrate inicial é limitado a 4 Mbps por espectador, com orçamento de referência de 12 Mbps por transmissor. O cliente observa `getStats()` a cada dois segundos e reduz bitrate, resolução e FPS ao detectar degradação; recupera um nível por vez após estabilidade. O congestion control nativo permanece ativo.
- Desconexões `disconnected` por cinco segundos ou `failed` iniciam recuperação com backoff exponencial e até cinco tentativas. Sair ou parar cancela conexões, timers e faixas locais.
- O botão de áudio do espectador controla a reprodução recebida. Se autoplay for bloqueado, use **Ativar áudio da transmissão** ou **Reproduzir transmissão**.

## Diagnóstico WebRTC

Adicione `?debug=webrtc` ao endereço da sala para mostrar estado ICE/PeerConnection, bitrate, RTT, jitter, perda, FPS, resolução, codec, encoder e motivo de limitação quando o navegador expuser esses dados. Dados indisponíveis aparecem como `—`. O painel também mostra navegador, plataforma, superfície escolhida, labels das faixas de áudio capturadas e número de espectadores. CPU/GPU não são exibidos porque não há uma API portátil para essas métricas.

## Deploy

### Frontend — GitHub Pages

O workflow em `.github/workflows/deploy-pages.yml` publica o frontend. Defina a variável de Actions `VITE_SIGNALING_URL` com a URL HTTPS do backend Render (sem barra final). O nome antigo `VITE_BACKEND_URL` também é aceito.

`frontend/public/404.html` preserva as rotas `/sala/:code` ao atualizar uma página do GitHub Pages.

### Backend — Render

O manifesto `render.yaml` publica o servidor Socket.IO no plano Free. Configure `ALLOWED_ORIGINS` com a origem exata do GitHub Pages, sem barra final. O serviço expõe `/health` e também mantém `/healthz` por compatibilidade. `PORT` é fornecida pelo Render.

TURN é opcional e deve apontar para um serviço TURN externo que aceite credenciais Coturn REST. O Render Free é usado aqui somente para HTTP/Socket.IO; não é o destino da mídia.

No plano Free, o serviço pode dormir após cerca de 15 minutos sem tráfego, e o primeiro acesso pode demorar até um minuto para acordá-lo. Salas em memória são apagadas quando o processo reinicia.

## Comandos e verificações

```sh
npm run build
npm run smoke:server
```

O smoke test cobre health, CORS, retorno STUN, criação e validação de salas, limite de 20 participantes, transmissão exclusiva, roteamento endereçado de SDP/ICE, stop e disconnect. Ele valida a sinalização, não a captura nem a mídia em redes reais.

Teste de mídia manual em dois dispositivos/navegadores:

1. A cria a sala, B entra, A transmite uma janela e B assiste.
2. A seleciona monitor/tela inteira e confirma que a captura é recusada.
3. Uma faixa explicitamente identificada como áudio do sistema ou microfone é omitida; vídeo segue sem áudio.
4. Quando o navegador fornece áudio isolado da guia/janela, B o ouve.
5. Uma segunda pessoa tenta transmitir e recebe recusa até a primeira parar.
6. B entra durante a transmissão e recebe vídeo sem refresh.
7. A encerra pelo botão e pelo seletor nativo; B deixa de ver a transmissão.
8. Em rede degradada, o diagnóstico mostra a adaptação progressiva de qualidade.

## Fora do escopo

SFU, Selkies, gravação, chat, login, persistência de salas, captura de áudio por processo via app desktop e encoder de hardware forçado.
