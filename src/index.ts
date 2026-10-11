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

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  // Set HOST=127.0.0.1 when running behind a reverse proxy like nginx.
  hostname: process.env.HOST ?? "0.0.0.0",
  routes: {
    "/": index,
    "/s/:id": index,
    "/ws": (req, server) => {
      const url = new URL(req.url);
      const room = url.searchParams.get("room") ?? "";
      const role = url.searchParams.get("role");
      if (!ROOM_ID.test(room) || (role !== "host" && role !== "viewer")) {
        return new Response("Bad request", { status: 400 });
      }
      const ok = server.upgrade(req, {
        data: { room, role, id: crypto.randomUUID() },
      });
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
      const room = getRoom(ws.data.room);
      if (ws.data.role === "host") {
        if (room.host) {
          send(ws, { type: "error", message: "This room already has a host." });
          ws.close();
          return;
        }
        room.host = ws;
        // Let the host connect to anyone who was already waiting.
        for (const id of room.viewers.keys()) send(ws, { type: "viewer-joined", id });
      } else {
        room.viewers.set(ws.data.id, ws);
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
    close(ws) {
      const room = rooms.get(ws.data.room);
      if (!room) return;
      if (ws.data.role === "host") {
        if (room.host !== ws) return;
        room.host = undefined;
        for (const v of room.viewers.values()) send(v, { type: "host-left" });
      } else {
        room.viewers.delete(ws.data.id);
        send(room.host, { type: "viewer-left", id: ws.data.id });
      }
      if (!room.host && room.viewers.size === 0) rooms.delete(ws.data.room);
    },
  },
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
});

console.log(`Screenshare running at ${server.url}`);
