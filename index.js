// Tank Fortress multiplayer relay server.
// It serves ./public and relays messages between the HOST browser (which runs the
// simulation) and the GUEST browsers (which send inputs and render snapshots).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_PLAYERS = 10;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml"
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();     // roomName -> { name, hostId, clients: Map(id -> ws) }
let nextId = 1;

function send(ws, str) { if (ws && ws.readyState === 1) ws.send(str); }

function broadcastPlayers(room) {
  const players = [...room.clients.values()].map(c => ({ id: c.id, name: c.pname }));
  const msg = JSON.stringify({ t: "players", players, hostId: room.hostId });
  for (const c of room.clients.values()) send(c, msg);
}

wss.on("connection", ws => {
  ws.id = nextId++;
  ws.room = null;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === "join") {
      if (ws.room) return;
      const name = String(m.room || "main").slice(0, 20);
      let room = rooms.get(name);
      if (!room) { room = { name, hostId: ws.id, clients: new Map() }; rooms.set(name, room); }
      if (room.clients.size >= MAX_PLAYERS) {
        return send(ws, JSON.stringify({ t: "error", msg: "That room is full (10 players max)." }));
      }
      ws.room = room;
      ws.pname = String(m.name || "Player").replace(/[<>&"']/g, "").slice(0, 14) || "Player";
      room.clients.set(ws.id, ws);
      send(ws, JSON.stringify({ t: "welcome", id: ws.id, hostId: room.hostId }));
      broadcastPlayers(room);
      return;
    }

    const room = ws.room;
    if (!room) return;

    if (m.t === "g2h" && ws.id !== room.hostId) {
      send(room.clients.get(room.hostId), JSON.stringify({ t: "g2h", from: ws.id, d: m.d }));
    } else if (m.t === "h2g" && ws.id === room.hostId) {
      const out = JSON.stringify({ t: "h2g", d: m.d });
      const isSnap = m.d && m.d.t === "snap";
      if (m.to === "all") {
        for (const c of room.clients.values()) {
          if (c.id === room.hostId) continue;
          if (isSnap && c.bufferedAmount > 512 * 1024) continue;   // slow client: drop this snapshot
          send(c, out);
        }
      } else {
        send(room.clients.get(m.to), out);
      }
    }
  });

  ws.on("close", () => {
    const room = ws.room;
    if (!room) return;
    room.clients.delete(ws.id);
    if (ws.id === room.hostId) {
      const msg = JSON.stringify({ t: "hostLeft" });
      for (const c of room.clients.values()) { send(c, msg); c.room = null; c.close(); }
      rooms.delete(room.name);
    } else if (room.clients.size === 0) {
      rooms.delete(room.name);
    } else {
      broadcastPlayers(room);
    }
  });
});

// keep idle connections alive and drop dead ones
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log("Tank Fortress server running on port " + PORT));
