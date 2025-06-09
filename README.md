# Servidor Proxy HTTP Avançado

## Visão Geral

Este é um servidor proxy HTTP baseado em Node.js, projetado para encaminhar requisições HTTP e HTTPS (via CONNECT). Ele implementa um mecanismo de autenticação personalizado baseado nos endereços IP dos clientes.

## Autenticação

O proxy utiliza um sistema de autenticação exclusivo:

- Os clientes devem enviar um cabeçalho `Proxy-Authorization` do tipo Basic.
- O nome de usuário deve estar no formato `xxx@IP_DO_CLIENTE`, onde `IP_DO_CLIENTE` corresponde ao endereço IP de conexão do cliente.
- A parte `xxx` é usada como um identificador para estatísticas de conexão.
- A senha na autenticação Basic é ignorada.

## Instalação

1. Certifique-se de que você tem o Node.js instalado em seu sistema.
2. Clone ou baixe este repositório.
3. Navegue até o diretório do projeto:
   ```bash
   cd /proxy-server
   ```
4. Nenhuma dependência adicional é necessária, pois o servidor utiliza apenas módulos nativos do Node.js.

## Uso

1. Inicie o servidor proxy:
   ```bash
   node index.js
   ```
2. Por padrão, o servidor escuta na porta 3131. Você pode alterar isso modificando a variável de ambiente `PORT`:
   ```bash
   PORT=8080 node index.js
   ```
3. Configure seu cliente (navegador, aplicativo, etc.) para usar este proxy. Defina o host do proxy como `localhost` (ou o IP do seu servidor) e a porta como `3131` (ou a porta que você especificou).
4. Quando solicitado para autenticação do proxy, forneça um nome de usuário no formato `identificador@SEU_ENDERECO_IP`. A senha pode ser qualquer coisa, pois é ignorada.

## Manipulação de Conexões

- O proxy lida com requisições HTTP regulares e requisições HTTPS CONNECT.
- Os timeouts de socket são definidos para 1 minuto para evitar que conexões ociosas consumam recursos.
- As estatísticas de conexão são mantidas com base na parte do identificador do nome de usuário.

## Logging

O proxy registra tentativas de conexão, conexões bem-sucedidas, erros no console com emojis apropriados para rápida identificação visual.
