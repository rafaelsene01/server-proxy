const http = require("http");
const https = require("https");
const fs = require("fs");
const url = require("url");
const net = require("net");

class SimpleHTTPProxy {
  constructor(port = 3131) {
    this.port = port;
    this.server = null;
    // Variável para guardar o tráfego de cada usuário
    this.userTraffic = null;
  }

  // Inicializar/atualizar estatísticas do usuário
  initUserStats() {
    if (!this.userTraffic) {
      this.userTraffic = {
        bytesUploaded: 0,
        bytesDownloaded: 0,
        totalRequests: 0,
        lastActivity: new Date(),
      };
    }
    this.userTraffic.lastActivity = new Date();
  }

  // Atualizar tráfego do usuário
  updateUserTraffic(uploaded, downloaded) {
    this.userTraffic.bytesUploaded += uploaded;
    this.userTraffic.bytesDownloaded += downloaded;
    this.userTraffic.totalRequests++;

    this.showAllStats();
  }

  // Lidar com requisições HTTP
  handleRequest(req, res) {
    this.initUserStats();

    console.log(req);
    const targetUrl = url.parse(req.url);
    if (!targetUrl.hostname) {
      res.writeHead(400);
      res.end("Invalid URL");
      return;
    }

    // Capturar bytes iniciais
    const startBytesRead = req.socket.bytesRead;
    const startBytesWritten = req.socket.bytesWritten;

    // Remover headers de proxy
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
      path: targetUrl.path,
      method: req.method,
      headers: headers,
    };

    const protocol = targetUrl.protocol === "https:" ? https : http;
    const proxyReq = protocol.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end("Bad Gateway");
      }
    });

    proxyReq.setTimeout(30000);
    req.pipe(proxyReq);

    // Calcular tráfego quando a resposta terminar
    res.on("finish", () => {
      const uploaded = req.socket.bytesRead - startBytesRead;
      const downloaded = req.socket.bytesWritten - startBytesWritten;
      this.updateUserTraffic(uploaded, downloaded);
    });
  }

  // Lidar com conexões HTTPS (CONNECT)
  handleConnect(req, clientSocket, head) {
    this.initUserStats();

    const [hostname, port] = req.url.split(":");
    if (!hostname || !port) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.end();
      return;
    }

    const serverSocket = net.connect(port, hostname, () => {
      clientSocket.write(
        "HTTP/1.1 200 Connection Established\r\n" +
          "Proxy-Agent: Simple-Proxy\r\n\r\n"
      );

      if (head && head.length > 0) {
        serverSocket.write(head);
      }

      clientSocket.pipe(serverSocket);
      serverSocket.pipe(clientSocket);
    });

    const cleanup = () => {
      // Calcular tráfego final antes de fechar
      const uploaded = clientSocket.bytesRead || 0;
      const downloaded = clientSocket.bytesWritten || 0;
      this.updateUserTraffic(uploaded, downloaded);

      if (!clientSocket.destroyed) clientSocket.end();
      if (!serverSocket.destroyed) serverSocket.end();
    };

    clientSocket.on("error", cleanup);
    serverSocket.on("error", cleanup);
    clientSocket.on("end", cleanup);
    serverSocket.on("end", cleanup);
  }

  showAllStats() {
    let stats = this.userTraffic;
    if (stats) {
      console.log("\n📈 Estatísticas dos usuários:");
      const upMB = (stats.bytesUploaded / 1024 / 1024).toFixed(2);
      const downMB = (stats.bytesDownloaded / 1024 / 1024).toFixed(2);
      console.log(
        `Uso geral: ${upMB} MB ↑ / ${downMB} MB ↓ (${stats.totalRequests} requests)`
      );
    }
  }

  start() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server.on("connect", (req, clientSocket, head) => {
      this.handleConnect(req, clientSocket, head);
    });

    this.server.on("clientError", (err, socket) => {
      if (socket.writable && !socket.destroyed) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      }
    });

    this.server.listen(this.port, () => {
      console.log(`🚀 Proxy rodando na porta ${this.port}`);
      console.log("🔑 Authentication: Required (Format: 'YOUR_IP')");
    });

    this.server.on("error", (err) => {
      console.error("Erro no servidor:", err.message);
    });
  }

  stop(callback) {
    if (this.server && this.server.listening) {
      this.server.close(callback);
    } else {
      if (callback) callback();
    }
  }
}

// Iniciar o proxy
const proxy = new SimpleHTTPProxy(process.env.PORT || 3131);
proxy.start();

// Exemplo de como acessar as estatísticas
setInterval(() => {
  proxy.showAllStats();
}, 5000); // Mostra estatísticas a cada minuto

// Shutdown graceful
process.on("SIGINT", () => {
  console.log("\nParando proxy...");
  // Mostrar estatísticas finais
  proxy.getAllStats();

  proxy.stop(() => {
    process.exit(0);
  });
});
