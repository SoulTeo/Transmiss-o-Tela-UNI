# Partilha — salas de compartilhamento de tela

Aplicação de compartilhamento de tela em salas privadas. O frontend usa React, TypeScript e Vite. O backend Node.js mantém as salas e a presença dos participantes por Socket.IO. O LiveKit SFU encaminha áudio e vídeo aos espectadores: o transmissor publica uma cópia no servidor de mídia, em vez de abrir uma conexão P2P para cada pessoa.

A captura permanece local no navegador de cada transmissor, conforme a decisão para esta migração. Selkies não é usado: ele transmite uma sessão de desktop hospedada em um host, o que mudaria de onde a tela de cada participante é capturada.

A captura continua acontecendo no navegador de quem transmite, por `getDisplayMedia()`. A conexão de mídia usa WebRTC entre cada navegador e o LiveKit, mas a mídia passa pelo SFU; participantes não enviam cópias diretamente uns aos outros.

## Rodar localmente

Requer Node.js 20.19.x ou 22.12 ou mais recente (até a série 26) e o servidor LiveKit instalado. Veja [Running LiveKit locally](https://docs.livekit.io/transport/self-hosting/local/) para instalar o executável no Windows, macOS ou Linux.

Instale as dependências:

```sh
npm install
```

Inicie o LiveKit em modo de desenvolvimento em um terminal:

```sh
livekit-server --dev --bind 127.0.0.1
```

Em outro terminal PowerShell, configure o backend e inicie as salas:

```powershell
$env:LIVEKIT_URL = "ws://localhost:7880"
$env:LIVEKIT_API_KEY = "devkey"
$env:LIVEKIT_API_SECRET = "secret"
npm run dev:server
```

Em um terceiro terminal, inicie o frontend:

```sh
npm run dev
```

Abra `http://localhost:5173`. As chaves `devkey` e `secret` são apenas as credenciais de desenvolvimento do servidor LiveKit local; nunca as use em produção. Se o backend estiver em outro endereço, defina `VITE_BACKEND_URL` em `frontend/.env.local`.

## Publicar

O frontend pode continuar no GitHub Pages. Configure a variável de Actions `VITE_BACKEND_URL` com a URL HTTPS do backend de salas. A variável antiga `VITE_SIGNALING_URL` continua aceita como compatibilidade.

O backend Node pode continuar no Render, usando [`render.yaml`](render.yaml). Configure no serviço:

- `ALLOWED_ORIGINS`: origem do frontend publicado.
- `LIVEKIT_URL`: endereço público do LiveKit, começando com `wss://`.
- `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET`: credenciais do projeto LiveKit; o segredo fica somente no backend.

O servidor LiveKit é um serviço de mídia separado e não está incluído no manifesto do Render. Em produção, use LiveKit Cloud ou hospede o SFU em uma máquina que permita abrir os endereços de mídia exigidos pelo WebRTC. A configuração padrão self-hosted do LiveKit usa WebSocket/API na porta 7880, WebRTC sobre TCP na 7881 e UDP na faixa 50000–60000; confira [Ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/) para adaptar as regras ao seu host. O backend de salas não recebe nem grava mídia.

## Comportamento das salas

- Os códigos têm seis caracteres; salas vazias expiram após 15 minutos. O estado continua em memória e se perde quando o backend reinicia.
- Cada sala aceita até 20 participantes e apenas uma transmissão ativa. O backend serializa o início e a parada da transmissão.
- Apelidos têm até 24 caracteres. Qualquer pessoa com o código pode entrar; nomes não são autenticação.
- O botão de compartilhar abre o seletor nativo do navegador. A aplicação mantém o vídeo capturado localmente e publica no LiveKit apenas as faixas de compartilhamento de tela e o áudio fornecido pela captura.
- Os espectadores assinam as faixas pelo LiveKit. O backend Socket.IO continua atualizando presença e estado da transmissão; ele não encaminha SDP, candidatos ICE ou mídia.
- O token LiveKit é gerado pelo backend e limitado à sala. Ele começa sem permissão para publicar; o backend habilita apenas fontes de compartilhamento de tela para quem adquiriu o bloqueio exclusivo, e revoga a permissão ao parar. A API key e o segredo não são enviados ao frontend.
- O navegador pode exigir um clique em **Ativar áudio da transmissão** para liberar a reprodução automática.
- Ao desconectar, a presença é removida e o app tenta reconectar. O cliente LiveKit também tenta recuperar a sessão de mídia.

## Captura e áudio

O navegador continua responsável por pedir a captura e fornecer as faixas. A aplicação mantém o tratamento de áudio por origem que já existia; o SFU não altera o seletor nem fabrica faixas que o navegador não entregou.

O botão **Parar de compartilhar** encerra as faixas locais e informa o backend para liberar a sala. O encerramento pelo seletor do navegador também para a transmissão.

## Limitações conhecidas

- `getDisplayMedia()` requer HTTPS (ou `localhost`) e a captura costuma estar disponível em navegadores desktop. Celulares podem assistir, mas nem todos suportam captura de tela.
- A disponibilidade e a origem do áudio dependem do navegador, do sistema operacional e da opção escolhida no seletor do navegador.
- O estado das salas não sobrevive ao reinício do backend. Para persistência, será preciso migrar esse estado para um armazenamento externo.
- Um SFU reduz o upload do transmissor para uma publicação, mas a mídia passa a consumir banda e recursos do serviço LiveKit. O limite de 20 participantes é um teto de produto, não uma garantia de desempenho.
- A validação de captura real, qualidade e latência depende de navegadores e redes distintas; o smoke test do backend não substitui essa matriz.
- O cliente LiveKit JavaScript está fixado na versão 2.18.0. Uma versão posterior testada alterou a configuração ICE depois de iniciar a negociação e falhou no Chromium usado nesta validação; revalide a conexão em Chrome e Edge antes de atualizar essa dependência.

## Checagem local do servidor

Com backend ativo e as variáveis `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET` configuradas, execute:

```sh
npm run smoke:server
```

O smoke test verifica health check, CORS, criação e validação de códigos de sala, limite de participantes, token LiveKit sem permissão inicial de publicação e remoção de participantes ao desconectar. A captura, publicação autorizada, múltiplos espectadores e reconexão dependem de navegador e servidor LiveKit ativos.

## Build local

```sh
npm run build
```
