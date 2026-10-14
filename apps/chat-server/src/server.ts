
import { randomBytes } from "node:crypto";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { z } from "zod";
import { PeerServer } from "peer";

const PEER_PORT = Number(process.env.PEER_PORT ?? 9000);

const peerServer = PeerServer({
  port: PEER_PORT,
  path: "/peerjs",
});

const PORT = Number(process.env.PORT ?? 4000);
const WEB_ORIGIN =
  process.env.WEB_ORIGIN ?? "http://localhost:3000";

const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
const MAX_PARTICIPANTS = 8;

type RoomState = {
  members: Map<string, string>; // Socket ID -> PeerJS ID
  expiryTimer: ReturnType<typeof setTimeout> | null;
};

const rooms = new Map<string, RoomState>();
const socketRoom = new Map<string, string>();
const socketPeer = new Map<string, string>();
const peerSocket = new Map<string, string>();

const app = express();
app.use(cors({ origin: WEB_ORIGIN }));

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: WEB_ORIGIN,
    methods: ["GET", "POST"],
  },
});

function scheduleEmptyRoomExpiry(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room || room.members.size > 0) return;

  if (room.expiryTimer) {
    clearTimeout(room.expiryTimer);
  }

  room.expiryTimer = setTimeout(() => {
    const current = rooms.get(roomId);

    if (current && current.members.size === 0) {
      rooms.delete(roomId);
      console.log(`Room expired: ${roomId}`);
    }
  }, EMPTY_ROOM_TTL_MS);

  room.expiryTimer.unref?.();
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/rooms", (_req, res) => {
  const roomId = randomBytes(16).toString("base64url");

  rooms.set(roomId, {
    members: new Map(),
    expiryTimer: null,
  });

  scheduleEmptyRoomExpiry(roomId);

  res.status(201).json({ roomId });
});

app.post("/api/rooms/:roomId", (_req, res) => {
  const { roomId } = _req.params;
  const room = rooms.get(roomId);

  if (!room) {
    rooms.set(roomId, {
        members: new Map(),
        expiryTimer: null,
    });

    scheduleEmptyRoomExpiry(roomId);
    res.status(200).json({ roomId });

    return;
  }

  res.status(200).json({ roomId });
});

const joinSchema = z.object({
  roomId: z.string().min(1).max(128),
  peerId: z.string().min(1).max(128),
});

io.on("connection", (socket) => {
  socket.on("room:join", (payload: unknown) => {
    const parsed = joinSchema.safeParse(payload);

    if (!parsed.success) {
      socket.emit("room:error", {
        message: "Invalid room or peer ID.",
      });
      return;
    }

    const { roomId, peerId } = parsed.data;
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit("room:error", {
        message: "Room does not exist or has expired.",
      });
      return;
    }

    if (socketRoom.has(socket.id)) {
      socket.emit("room:error", {
        message: "This connection has already joined a room.",
      });
      return;
    }

    const existingOwner = peerSocket.get(peerId);

    if (existingOwner && existingOwner !== socket.id) {
      socket.emit("room:error", {
        message: "That peer ID is already registered.",
      });
      return;
    }

    if (room.members.size >= MAX_PARTICIPANTS) {
      socket.emit("room:error", {
        message: "Room is full.",
      });
      return;
    }

    // Capture the existing members before adding the newcomer.
    const peers = [...room.members.values()];

    if (room.expiryTimer) {
      clearTimeout(room.expiryTimer);
      room.expiryTimer = null;
    }

    room.members.set(socket.id, peerId);
    socketRoom.set(socket.id, roomId);
    socketPeer.set(socket.id, peerId);
    peerSocket.set(peerId, socket.id);

    socket.join(roomId);

    socket.emit("room:peers", {
      roomId,
      peers,
    });

    socket.to(roomId).emit("peer:joined", {
      roomId,
      peerId,
    });
  });

  socket.on("disconnecting", () => {
    const roomId = socketRoom.get(socket.id);
    const peerId = socketPeer.get(socket.id);

    if (!roomId || !peerId) return;

    const room = rooms.get(roomId);

    if (room) {
      room.members.delete(socket.id);

      socket.to(roomId).emit("peer:left", {
        roomId,
        peerId,
      });

      if (room.members.size === 0) {
        scheduleEmptyRoomExpiry(roomId);
      }
    }

    if (peerSocket.get(peerId) === socket.id) {
      peerSocket.delete(peerId);
    }

    socketRoom.delete(socket.id);
    socketPeer.delete(socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Application server listening on port ${PORT}`);
});

// PeerJS server listens on a different port
peerServer.on("connection", (client) => {
  console.log(`PeerJS client connected: ${client.getId()}`);
});

peerServer.on("disconnect", (client) => {
  console.log(`PeerJS client disconnected: ${client.getId()}`);
});

