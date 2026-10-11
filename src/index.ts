import index from "./public/index.html";
import type { ServerWebSocket } from "bun";

type Role = "host" | "viewer";
type WsData = { room: string; role: Role; id: string };
type Socket = ServerWebSocket<WsData>;

type Room = { host?: Socket; viewers: Map<string, Socket> };

const rooms = new Map<string, Room>();

function getRoom(id: string): Room {
  let room = rooms.get(id);
  if (!room) {
    room = { viewers: new Map() };
    rooms.set(id, room);
  }
  return room;
}

function send(ws: Socket | undefined, msg: unknown) {
  ws?.send(JSON.stringify(msg));
}

const ROOM_ID = /^[a-z0-9]{4,32}$/;
// Chosen by the client and kept across reconnects, so a dropped socket can
// reclaim its slot instead of looking like a brand-new peer.
const PEER_ID = /^[0-9a-f-]{36}$/;

// STUN by default. Viewers on strict networks (corporate, mobile carrier NAT)
// need a TURN relay: set ICE_SERVERS to a JSON array of RTCIceServer objects.
const ICE_SERVERS: unknown[] = process.env.ICE_SERVERS
  ? JSON.parse(process.env.ICE_SERVERS)
  : [{ urls: "stun:stun.l.google.com:19302" }];

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  // Set HOST=127.0.0.1 when running behind a reverse proxy like nginx.
  hostname: process.env.HOST ?? "0.0.0.0",
  routes: {
    "/": index,
    "/s/:id": index,
    "/api/ice": Response.json(ICE_SERVERS),
    "/ws": (req, server) => {
      const url = new URL(req.url);
      const room = url.searchParams.get("room") ?? "";
      const role = url.searchParams.get("role");
      const id = url.searchParams.get("id") ?? "";
      if (!ROOM_ID.test(room) || !PEER_ID.test(id) || (role !== "host" && role !== "viewer")) {
        return new Response("Bad request", { status: 400 });
      }
      const ok = server.upgrade(req, { data: { room, role, id } });
      return ok ? undefined : new Response("Upgrade failed", { status: 400 });
    },
  },
  websocket: {
    data: {} as WsData,
    // Signaling sockets go quiet once peers connect. A short idle timeout makes
    // Bun ping them often, so proxies (nginx defaults to 60s) don't drop them.
    idleTimeout: 30,
    sendPings: true,
    open(ws) {
      console.log(`[${ws.data.room}] ${ws.data.role} ${ws.data.id.slice(0, 8)} connected`);
      const room = getRoom(ws.data.room);
      if (ws.data.role === "host") {
        if (room.host && room.host.data.id !== ws.data.id) {
          send(ws, { type: "error", message: "This room already has a host." });
          ws.close();
          return;
        }
        // Same host reconnecting before its old socket noticed it was dead.
        const stale = room.host;
        room.host = ws;
        stale?.close();
        // Let the host connect to anyone who was already waiting.
        for (const id of room.viewers.keys()) send(ws, { type: "viewer-joined", id });
      } else {
        const stale = room.viewers.get(ws.data.id);
        room.viewers.set(ws.data.id, ws);
        stale?.close();
        if (room.host) send(room.host, { type: "viewer-joined", id: ws.data.id });
        else send(ws, { type: "waiting" });
      }
    },
    message(ws, raw) {
      let msg: { type?: string; to?: string; data?: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type !== "signal") return;
      const room = rooms.get(ws.data.room);
      if (!room) return;
      if (ws.data.role === "host") {
        if (msg.to) send(room.viewers.get(msg.to), { type: "signal", data: msg.data });
      } else {
        send(room.host, { type: "signal", from: ws.data.id, data: msg.data });
      }
    },
    close(ws, code, reason) {
      console.log(`[${ws.data.room}] ${ws.data.role} ${ws.data.id.slice(0, 8)} closed: ${code} ${reason}`);
      const room = rooms.get(ws.data.room);
      if (!room) return;
      if (ws.data.role === "host") {
        if (room.host !== ws) return;
        room.host = undefined;
        for (const v of room.viewers.values()) send(v, { type: "host-left" });
      } else {
        if (room.viewers.get(ws.data.id) !== ws) return;
        room.viewers.delete(ws.data.id);
        send(room.host, { type: "viewer-left", id: ws.data.id });
      }
      if (!room.host && room.viewers.size === 0) rooms.delete(ws.data.room);
    },
  },
  // Production unless explicitly asked for dev mode. Hot reload refreshes open
  // pages when files change, which ends any live share, so keep it out of prod.
  development: process.env.NODE_ENV === "development" && { hmr: true, console: true },
});

console.log(`Screenshare running at ${server.url} (${server.development ? "development" : "production"})`);
