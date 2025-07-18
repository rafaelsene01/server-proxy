const http = require("http");
const https = require("https");
const url = require("url");
const net = require("net");

class SimpleHTTPProxy {
  constructor(port = 3131) {
    this.port = port;
    this.server = null;
    // Variável para guardar o tráfego de cada usuário
    this.userTraffic = {};
  }

  // Inicializar/atualizar estatísticas do usuário
  initUserStats(username) {
    if (!this.userTraffic[username]) {
      this.userTraffic[username] = {
        bytesUploaded: 0,
        bytesDownloaded: 0,
        totalRequests: 0,
        lastActivity: new Date(),
      };
    }
    this.userTraffic[username].lastActivity = new Date();
  }

  // Atualizar tráfego do usuário
  updateUserTraffic(username, uploaded, downloaded) {
    this.initUserStats(username);
    this.userTraffic[username].bytesUploaded += uploaded;
    this.userTraffic[username].bytesDownloaded += downloaded;
    this.userTraffic[username].totalRequests++;

    // Log do tráfego
    const upMB = (
      this.userTraffic[username].bytesUploaded /
      1024 /
      1024
    ).toFixed(2);
    const downMB = (
      this.userTraffic[username].bytesDownloaded /
      1024 /
      1024
    ).toFixed(2);
    // console.log(
    //   `📊 ${username}: ${upMB} MB ↑ / ${downMB} MB ↓ (Total: ${this.userTraffic[username].totalRequests} requests)`
    // );
  }

  // Verificar autenticação básica
  checkAuth(req) {
    const authHeader = req.headers["proxy-authorization"];
    if (!authHeader) return { valid: false };

    try {
      const parts = authHeader.split(" ");
      if (parts.length !== 2 || parts[0].toLowerCase() !== "basic") {
        return { valid: false };
      }

      const credentials = Buffer.from(parts[1], "base64").toString();
      const [username] = credentials.split(":");

      return username ? { valid: true, username } : { valid: false };
    } catch (error) {
      return { valid: false };
    }
  }

  // Lidar com requisições HTTP
  handleRequest(req, res) {
    const authResult = this.checkAuth(req);

    if (!authResult.valid) {
      res.writeHead(407, {
        "Proxy-Authenticate": 'Basic realm="Proxy Server"',
      });
      res.end("Proxy Authentication Required");
      return;
    }

    const username = authResult.username;
    this.initUserStats(username);

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
      this.updateUserTraffic(username, uploaded, downloaded);
    });
  }

  // Lidar com conexões HTTPS (CONNECT)
  handleConnect(req, clientSocket, head) {
    const authResult = this.checkAuth(req);

    if (!authResult.valid) {
      clientSocket.write(
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
          'Proxy-Authenticate: Basic realm="Proxy Server"\r\n' +
          "Connection: close\r\n\r\n"
      );
      clientSocket.end();
      return;
    }

    const username = authResult.username;
    this.initUserStats(username);

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
      this.updateUserTraffic(username, uploaded, downloaded);

      if (!clientSocket.destroyed) clientSocket.end();
      if (!serverSocket.destroyed) serverSocket.end();
    };

    clientSocket.on("error", cleanup);
    serverSocket.on("error", cleanup);
    clientSocket.on("end", cleanup);
    serverSocket.on("end", cleanup);
  }

  // Método para obter estatísticas de um usuário específico
  // getUserStats(username) {
  //   return this.userTraffic[username] || null;
  // }

  // Método para obter estatísticas de todos os usuários
  getAllStats() {
    return this.userTraffic;
  }

  // Método para resetar estatísticas de um usuário
  // resetUserStats(username) {
  //   if (this.userTraffic[username]) {
  //     this.userTraffic[username] = {
  //       bytesUploaded: 0,
  //       bytesDownloaded: 0,
  //       totalRequests: 0,
  //       lastActivity: new Date(),
  //     };
  //   }
  // }

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
      console.log("🔑 Authentication: Required (Format: 'xxx@YOUR_IP')");
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
  const stats = proxy.getAllStats();
  if (Object.keys(stats).length > 0) {
    console.log("\n📈 Estatísticas dos usuários:");
    Object.entries(stats).forEach(([username, data]) => {
      const upMB = (data.bytesUploaded / 1024 / 1024).toFixed(2);
      const downMB = (data.bytesDownloaded / 1024 / 1024).toFixed(2);
      console.log(
        `  ${username}: ${upMB} MB ↑ / ${downMB} MB ↓ (${data.totalRequests} requests)`
      );
    });
  }
}, 60000); // Mostra estatísticas a cada minuto

// Shutdown graceful
process.on("SIGINT", () => {
  console.log("\nParando proxy...");
  // Mostrar estatísticas finais
  const stats = proxy.getAllStats();
  if (Object.keys(stats).length > 0) {
    console.log("\n📊 Estatísticas finais:");
    Object.entries(stats).forEach(([username, data]) => {
      const upMB = (data.bytesUploaded / 1024 / 1024).toFixed(2);
      const downMB = (data.bytesDownloaded / 1024 / 1024).toFixed(2);
      console.log(
        `  ${username}: ${upMB} MB ↑ / ${downMB} MB ↓ (${data.totalRequests} requests)`
      );
    });
  }
  proxy.stop(() => {
    process.exit(0);
  });
});
