const http = require("http");
const https = require("https");
const url = require("url");
const net = require("net");
const fs = require("fs");
const crypto = require("crypto");

class AdvancedHTTPProxy {
  constructor(port = 3131, configFile = "users.json") {
    this.port = port;
    this.configFile = configFile;
    this.users = {};
    this.userStats = {}; // Estatísticas por usuário
    this.server = null;
    this.loadUsers();

    // Recarregar usuários a cada 30 segundos
    setInterval(() => this.loadUsers(), 30000);
  }

  // Carregar usuários do arquivo JSON
  loadUsers() {
    try {
      if (fs.existsSync(this.configFile)) {
        const data = fs.readFileSync(this.configFile, "utf8");
        const config = JSON.parse(data);
        this.users = config.users || {};
        console.log(
          `📁 Carregados ${Object.keys(this.users).length} usuários do arquivo`
        );
      } else {
        // Criar arquivo padrão se não existir
        this.createDefaultConfig();
      }
    } catch (error) {
      console.error("❌ Erro ao carregar usuários:", error.message);
    }
  }

  // Criar configuração padrão
  createDefaultConfig() {
    const defaultConfig = {
      users: {
        admin: {
          password: "admin123",
          enabled: true,
          maxConnections: 10,
          allowedIPs: [], // Vazio = todos os IPs
          description: "Administrador",
        },
        user1: {
          password: "senha123",
          enabled: true,
          maxConnections: 5,
          allowedIPs: [],
          description: "Usuário padrão",
        },
      },
      settings: {
        logLevel: "info",
        maxFailedAttempts: 5,
        blockDuration: 300000, // 5 minutos
      },
    };

    fs.writeFileSync(this.configFile, JSON.stringify(defaultConfig, null, 2));
    console.log(`📝 Arquivo de configuração criado: ${this.configFile}`);
    this.users = defaultConfig.users;
  }

  // Gerar hash da senha
  hashPassword(password) {
    return crypto.createHash("sha256").update(password).digest("hex");
  }

  // Adicionar usuário via código
  addUser(username, password, options = {}) {
    const userData = {
      password: password,
      enabled: options.enabled !== false,
      maxConnections: options.maxConnections || 5,
      allowedIPs: options.allowedIPs || [],
      description: options.description || "Usuário criado programaticamente",
      createdAt: new Date().toISOString(),
    };

    this.users[username] = userData;
    this.saveUsers();
    console.log(`✅ Usuário '${username}' adicionado`);
  }

  // Remover usuário
  removeUser(username) {
    if (this.users[username]) {
      delete this.users[username];
      delete this.userStats[username];
      this.saveUsers();
      console.log(`🗑️ Usuário '${username}' removido`);
      return true;
    }
    return false;
  }

  // Salvar usuários no arquivo
  saveUsers() {
    try {
      let config = { users: this.users, settings: {} };

      if (fs.existsSync(this.configFile)) {
        const existing = JSON.parse(fs.readFileSync(this.configFile, "utf8"));
        config.settings = existing.settings || {};
      }

      fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
    } catch (error) {
      console.error("❌ Erro ao salvar usuários:", error.message);
    }
  }

  // Verificar autenticação avançada
  checkAuth(req, clientIP) {
    if (Object.keys(this.users).length === 0) return { valid: true };

    const authHeader = req.headers["proxy-authorization"];
    if (!authHeader) {
      return { valid: false, reason: "Sem autenticação" };
    }

    try {
      const authType = authHeader.split(" ")[0];
      if (authType !== "Basic") {
        return { valid: false, reason: "Tipo de auth inválido" };
      }

      const credentials = Buffer.from(
        authHeader.split(" ")[1],
        "base64"
      ).toString();
      const [username, password] = credentials.split(":");

      const user = this.users[username];
      if (!user) {
        return { valid: false, reason: "Usuário não encontrado", username };
      }

      if (!user.enabled) {
        return { valid: false, reason: "Usuário desabilitado", username };
      }

      if (user.password !== password) {
        return { valid: false, reason: "Senha incorreta", username };
      }

      // Verificar IP permitido
      if (user.allowedIPs.length > 0 && !user.allowedIPs.includes(clientIP)) {
        return { valid: false, reason: "IP não autorizado", username };
      }

      // Verificar limite de conexões
      const userConnections = this.userStats[username]?.connections || 0;
      if (userConnections >= user.maxConnections) {
        return {
          valid: false,
          reason: "Limite de conexões excedido",
          username,
        };
      }

      return { valid: true, username, user };
    } catch (error) {
      return { valid: false, reason: "Erro de processamento" };
    }
  }

  // Atualizar estatísticas do usuário
  updateUserStats(username, action) {
    if (!this.userStats[username]) {
      this.userStats[username] = {
        connections: 0,
        totalRequests: 0,
        lastAccess: null,
      };
    }

    const stats = this.userStats[username];

    switch (action) {
      case "connect":
        stats.connections++;
        stats.lastAccess = new Date();
        break;
      case "disconnect":
        stats.connections = Math.max(0, stats.connections - 1);
        break;
      case "request":
        stats.totalRequests++;
        break;
    }
  }

  // Manipular requisições HTTP
  handleHttpRequest(req, res) {
    const clientIP = req.connection.remoteAddress || req.socket.remoteAddress;
    const auth = this.checkAuth(req, clientIP);

    if (!auth.valid) {
      console.log(
        `❌ ${clientIP} - ${auth.reason}${
          auth.username ? ` (${auth.username})` : ""
        }`
      );
      res.writeHead(407, {
        "Proxy-Authenticate": 'Basic realm="Proxy Authentication Required"',
        "Content-Type": "text/plain",
      });
      res.end("Proxy Authentication Required");
      return;
    }

    if (auth.username) {
      this.updateUserStats(auth.username, "request");
      console.log(
        `✅ ${clientIP} - ${auth.username} - ${req.method} ${req.url}`
      );
    }

    const targetUrl = req.url;
    const parsedUrl = url.parse(targetUrl);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.path,
      method: req.method,
      headers: { ...req.headers },
    };

    delete options.headers["proxy-authorization"];
    delete options.headers["proxy-connection"];

    const protocol = parsedUrl.protocol === "https:" ? https : http;

    const proxyReq = protocol.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      console.error(
        `🔴 Erro no proxy para ${auth.username || "anônimo"}:`,
        err.message
      );
      res.writeHead(500);
      res.end("Proxy Error");
    });

    req.pipe(proxyReq);
  }

  // Manipular conexões HTTPS
  handleHttpsConnect(req, clientSocket, head) {
    const clientIP = clientSocket.remoteAddress;
    const auth = this.checkAuth(req, clientIP);

    if (!auth.valid) {
      console.log(
        `❌ HTTPS ${clientIP} - ${auth.reason}${
          auth.username ? ` (${auth.username})` : ""
        }`
      );
      clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\n");
      clientSocket.write(
        'Proxy-Authenticate: Basic realm="Proxy Authentication Required"\r\n\r\n'
      );
      clientSocket.end();
      return;
    }

    if (auth.username) {
      this.updateUserStats(auth.username, "connect");
    }

    const [hostname, port] = req.url.split(":");
    console.log(
      `🔒 HTTPS ${clientIP} - ${
        auth.username || "anônimo"
      } - ${hostname}:${port}`
    );

    const serverSocket = net.connect(port || 443, hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on("error", (err) => {
      console.error(
        `🔴 Erro HTTPS para ${auth.username || "anônimo"}:`,
        err.message
      );
      clientSocket.end();
    });

    clientSocket.on("close", () => {
      if (auth.username) {
        this.updateUserStats(auth.username, "disconnect");
      }
      serverSocket.end();
    });
  }

  // Obter estatísticas
  getStats() {
    return {
      users: Object.keys(this.users).length,
      activeConnections: Object.values(this.userStats).reduce(
        (sum, stats) => sum + stats.connections,
        0
      ),
      userStats: this.userStats,
    };
  }

  // Listar usuários
  listUsers() {
    console.log("\n📋 Usuários cadastrados:");
    Object.entries(this.users).forEach(([username, userData]) => {
      const stats = this.userStats[username];
      console.log(`   ${userData.enabled ? "✅" : "❌"} ${username}`);
      console.log(`      Desc: ${userData.description}`);
      console.log(`      Max conexões: ${userData.maxConnections}`);
      console.log(`      Conexões ativas: ${stats?.connections || 0}`);
      console.log(`      Total requests: ${stats?.totalRequests || 0}`);
      if (stats?.lastAccess) {
        console.log(
          `      Último acesso: ${stats.lastAccess.toLocaleString()}`
        );
      }
      console.log("");
    });
  }

  start() {
    this.server = http.createServer();

    this.server.on("request", (req, res) => {
      this.handleHttpRequest(req, res);
    });

    this.server.on("connect", (req, clientSocket, head) => {
      this.handleHttpsConnect(req, clientSocket, head);
    });

    this.server.listen(this.port, () => {
      console.log(
        `🚀 Proxy Avançado rodando -> http://sene:senha123@SEU_IP:${this.port}`
      );
      // console.log(`📁 Configuração: ${this.configFile}`);
      // this.listUsers();

      // // Comandos úteis
      // console.log("📝 Comandos úteis:");
      // console.log(
      //   '   proxy.addUser("novo_user", "senha123", { description: "Novo usuário" })'
      // );
      // console.log('   proxy.removeUser("usuario")');
      // console.log("   proxy.listUsers()");
      // console.log("   proxy.getStats()");
      // console.log("");
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      console.log("🛑 Proxy parado");
    }
  }
}

// Criar e iniciar o proxy
const proxy = new AdvancedHTTPProxy(3131, "proxy-users.json");
proxy.start();

// Exemplo de como adicionar usuários programaticamente
// setTimeout(() => {
//   proxy.addUser("app_mobile", "mobile_secret_2024", {
//     description: "Aplicativo Mobile",
//     maxConnections: 3,
//   });

//   proxy.addUser("bot_scraper", "bot_token_xyz", {
//     description: "Bot de Web Scraping",
//     maxConnections: 8,
//     allowedIPs: ["192.168.1.100", "10.0.0.50"], // IPs específicos
//   });
// }, 2000);

// Mostrar estatísticas a cada 60 segundos
setInterval(() => {
  const stats = proxy.getStats();
  console.log(
    `📊 Stats: ${stats.users} usuários, ${stats.activeConnections} conexões ativas`
  );
}, 5000);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Parando o proxy...");
  proxy.stop();
  process.exit(0);
});
