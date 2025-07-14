const http = require("http");
const https = require("https");
const url = require("url");
const net = require("net");

class AdvancedHTTPProxy {
  constructor(port = 3131) {
    this.port = port;
    this.userStats = {};
    this.server = null;
  }

  // Check xxx@CLIENT_IP authentication
  checkAuth(req, clientIP) {
    const authHeader = req.headers["proxy-authorization"];
    if (!authHeader) {
      return { valid: false, reason: "Proxy-Authorization header missing" };
    }

    try {
      const parts = authHeader.split(" ");
      if (parts.length !== 2 || parts[0].toLowerCase() !== "basic") {
        return {
          valid: false,
          reason: "Invalid authentication type (expected 'Basic')",
        };
      }

      const credentials = Buffer.from(parts[1], "base64").toString();
      const [username] = credentials.split(":");

      if (!username) {
        return {
          valid: false,
          reason: "Invalid credential format (expected 'username:password')",
        };
      }

      return { valid: true, username };
    } catch (error) {
      console.error("❌ Error processing authentication:", error.message);
      return { valid: false, reason: "Authentication processing error" };
    }
  }

  // Update user statistics (identified by 'xxx' part)
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

  logTraffic(
    userIdentifier,
    clientIP,
    uploadedBytes,
    downloadedBytes,
    protocol
  ) {
    const upKB = (uploadedBytes / 1024).toFixed(2);
    const downKB = (downloadedBytes / 1024).toFixed(2);
    console.log(
      `📊 [${protocol}] ${userIdentifier}@${clientIP} trafegou ${upKB} KB ↑ / ${downKB} KB ↓`
    );
  }

  // Handle HTTP requests
  handleRequest(req, res) {
    const clientIP = req.socket.remoteAddress;
    const authResult = this.checkAuth(req, clientIP);

    if (!authResult.valid) {
      console.warn(
        `⚠️ HTTP authentication failed for ${clientIP}${
          authResult.username ? ` (attempted: ${authResult.username})` : ""
        }: ${authResult.reason}`
      );
      res.writeHead(407, {
        "Proxy-Authenticate":
          'Basic realm="Proxy Server - Format: xxx@YOUR_IP"',
      });
      res.end(
        "Proxy Authentication Required - Expected format: xxx@YOUR_IP (password is ignored)"
      );
      return;
    }

    const userIdentifier = authResult.username; // This is the 'xxx' part
    this.updateUserStats(userIdentifier, "request");
    const startRead = req.socket.bytesRead;
    const startWritten = req.socket.bytesWritten;
    console.log(
      `➡️  ${userIdentifier}@${clientIP} -> ${req.method} ${req.url}`
    );

    const { method, url: reqUrl, headers: clientHeaders } = req;
    const targetUrlParts = url.parse(reqUrl);

    if (!targetUrlParts.hostname) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid target URL specified.");
      console.error(
        `❌ Invalid target URL: ${reqUrl} from ${userIdentifier}@${clientIP}`
      );
      return;
    }

    const outgoingHeaders = { ...clientHeaders };
    delete outgoingHeaders["proxy-authorization"];
    delete outgoingHeaders["proxy-connection"];

    const options = {
      hostname: targetUrlParts.hostname,
      port:
        targetUrlParts.port ||
        (targetUrlParts.protocol === "https:" ? 443 : 80),
      path: targetUrlParts.path,
      method: method,
      headers: outgoingHeaders,
    };

    const protocol = targetUrlParts.protocol === "https:" ? https : http;

    const proxyReq = protocol.request(options, (proxyRes) => {
      console.log(
        `⬅️  ${options.method} ${targetUrlParts.href} responded with ${proxyRes.statusCode} for ${userIdentifier}@${clientIP}`
      );
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on("error", (err) => {
      console.error(
        `❌ Error connecting to target ${targetUrlParts.href} for ${userIdentifier}@${clientIP}:`,
        err.message
      );
      if (!res.writableEnded) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(
          `Bad Gateway: Error connecting to target server - ${err.message}`
        );
      }
    });

    proxyReq.on("timeout", () => {
      console.error(
        `❌ Timeout connecting to target ${targetUrlParts.href} for ${userIdentifier}@${clientIP}`
      );
      proxyReq.destroy();
      if (!res.writableEnded) {
        res.writeHead(504, { "Content-Type": "text/plain" });
        res.end("Gateway Timeout: The target server did not respond in time.");
      }
    });

    proxyReq.setTimeout(30000); // 30 seconds timeout

    req.pipe(proxyReq, { end: true });

    res.on("finish", () => {
      const uploaded = req.socket.bytesRead - startRead;
      const downloaded = req.socket.bytesWritten - startWritten;
      this.logTraffic(userIdentifier, clientIP, uploaded, downloaded, "HTTP");
    });
  }

  // Handle HTTPS CONNECT requests
  handleConnect(req, clientSocket, head) {
    const clientIP = clientSocket.remoteAddress;
    const authResult = this.checkAuth(req, clientIP);

    if (!authResult.valid) {
      console.warn(
        `⚠️ CONNECT authentication failed for ${clientIP}${
          authResult.username ? ` (attempted: ${authResult.username})` : ""
        }: ${authResult.reason}`
      );
      clientSocket.write(
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
          'Proxy-Authenticate: Basic realm="Proxy Server - Format: xxx@YOUR_IP"\r\n' +
          "Connection: close\r\n" +
          "\r\n"
      );
      clientSocket.end();
      return;
    }

    const userIdentifier = authResult.username; // This is the 'xxx' part
    this.updateUserStats(userIdentifier, "connect");
    console.log(`🔗 ${userIdentifier}@${clientIP} -> CONNECT ${req.url}`);

    const connectUrl = url.parse(`http://${req.url}`); //CONNECT target is host:port
    const targetHostname = connectUrl.hostname;
    const targetPort = connectUrl.port;

    if (!targetHostname || !targetPort) {
      clientSocket.write(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"
      );
      clientSocket.end();
      console.error(
        `❌ Invalid CONNECT request target: ${req.url} from ${userIdentifier}@${clientIP}`
      );
      this.updateUserStats(userIdentifier, "disconnect"); // Decrement connection count
      return;
    }

    const serverSocket = net.connect(targetPort, targetHostname, () => {
      console.log(
        `🔌 Connected to ${targetHostname}:${targetPort} for ${userIdentifier}@${clientIP}`
      );
      clientSocket.write(
        "HTTP/1.1 200 Connection Established\r\n" +
          "Proxy-Agent: Advanced-Node-Proxy\r\n" +
          "\r\n"
      );
      if (head && head.length > 0) {
        serverSocket.write(head);
      }

      clientSocket.pipe(serverSocket);
      serverSocket.pipe(clientSocket);
    });

    const onSocketError = (socketType, timeout = false) => {
      if (!timeout)
        console.error(
          `❌ Socket error (${socketType}) for ${targetHostname}:${targetPort} (Client: ${userIdentifier}@${clientIP}):`
        );
      if (!clientSocket.destroyed) {
        try {
          clientSocket.write(
            `HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n`
          );
        } catch (e) {
          /* ignore */
        }
        clientSocket.end();
      }
      if (!serverSocket.destroyed) {
        serverSocket.end();
      }
      this.updateUserStats(userIdentifier, "disconnect");
    };

    clientSocket.on("error", (err) => onSocketError("client (CONNECT)", err));
    serverSocket.on("error", (err) => onSocketError("server (CONNECT)", err));

    clientSocket.on("end", () => {
      this.updateUserStats(userIdentifier, "disconnect");
      if (!serverSocket.destroyed) serverSocket.end();
    });
    serverSocket.on("end", () => {
      if (!clientSocket.destroyed) clientSocket.end();
    });

    clientSocket.on("close", () => {
      const uploaded = clientSocket.bytesRead;
      const downloaded = clientSocket.bytesWritten;
      this.logTraffic(
        userIdentifier,
        clientIP,
        uploaded,
        downloaded,
        "CONNECT"
      );
    });

    clientSocket.on("timeout", () => {
      onSocketError("client (CONNECT timeout)", true);
    });
    serverSocket.on("timeout", () => {
      onSocketError("server (CONNECT timeout)", true);
    });

    clientSocket.setTimeout(60000); // 1 minute timeout for client socket
    serverSocket.setTimeout(60000); // 1 minute timeout for server socket
  }

  start() {
    this.server = http.createServer((req, res) => {
      try {
        this.handleRequest(req, res);
      } catch (error) {
        console.error("💥 Unexpected error in handleRequest:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
        }
        if (!res.writableEnded) {
          res.end("Internal Server Error");
        }
      }
    });

    this.server.on("connect", (req, clientSocket, head) => {
      try {
        this.handleConnect(req, clientSocket, head);
      } catch (error) {
        console.error("💥 Unexpected error in handleConnect:", error);
        if (!clientSocket.destroyed) {
          try {
            clientSocket.write(
              `HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n`
            );
          } catch (e) {
            /*ignore*/
          }
          clientSocket.end();
        }
      }
    });

    this.server.on("clientError", (err, socket) => {
      console.error("❌ Client Error (event):", err.message);
      if (socket.writable && !socket.destroyed) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      }
    });

    this.server.listen(this.port, () => {
      console.log(`🚀 Advanced Proxy listening on port ${this.port}`);
      console.log(
        "🔑 Authentication: Required (Format: 'xxx@YOUR_IP' in Proxy-Authorization header, password ignored)"
      );
    });

    this.server.on("error", (err) => {
      console.error("❌ Error starting proxy server:", err.message);
      if (err.code === "EADDRINUSE") {
        console.error(
          `🔴 Port ${this.port} is already in use. Please try a different port.`
        );
      }
    });
  }

  stop(callback) {
    console.log("⏳ Stopping proxy server...");
    if (this.server && this.server.listening) {
      this.server.close((err) => {
        if (err) {
          console.error("❌ Error stopping proxy server:", err.message);
        } else {
          console.log("🛑 Proxy server stopped.");
        }
        this.server = null; // Clear the server reference
        if (callback) callback(err);
      });
    } else {
      console.log("ℹ️ Proxy server was not running or already stopped.");
      this.server = null;
      if (callback) callback();
    }
  }
}

// Create and start the proxy
const proxy = new AdvancedHTTPProxy(process.env.PORT || 3131);
proxy.start();

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Stopping proxy via SIGINT...");
  proxy.stop(() => {
    process.exit(0);
  });
});
