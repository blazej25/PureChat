
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import { createRoomSchema, joinSchema, candidateSchema, signalSchema } from "./schemas/schemas.js";

const PORT = Number(process.env.PORT ?? 4000);
const WEB_ORIGIN =
  process.env.WEB_ORIGIN ?? "http://localhost:3000";

const UNUSED_ROOM_TTL_MS = 30 * 60 * 1000;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

const app = express();

app.use(cors({ origin: WEB_ORIGIN }));

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: WEB_ORIGIN,
    methods: ["GET", "POST"],
  },
});

// Room IDs and cleanup timers are kept only in memory.
const rooms = new Map<string, NodeJS.Timeout | null>();

function scheduleRoomCleanup(roomId: string, delayMs: number) {
  const previousTimer = rooms.get(roomId);

  if (previousTimer) {
    clearTimeout(previousTimer);
  }

  const timer = setTimeout(() => {
    const members = io.sockets.adapter.rooms.get(roomId);

    if (!members || members.size === 0) {
      rooms.delete(roomId);
      console.log(`Room expired: ${roomId}`);
    } else {
      rooms.set(roomId, null);
    }
  }, delayMs);

  timer.unref();
  rooms.set(roomId, timer);
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Create a room and return its shareable ID.
app.post("/api/rooms", (_req, res) => {
  const roomId = randomBytes(16).toString("base64url");

  rooms.set(roomId, null);
  scheduleRoomCleanup(roomId, UNUSED_ROOM_TTL_MS);

  res.status(201).json({ roomId });
});


app.post("/api/rooms/:roomId", (req, res) => {
  const parsed = createRoomSchema.safeParse(req.params);

  if (!parsed.success) {
    res.status(400).json({ message: "Invalid room ID." });
    return;
  }

  const { roomId } = parsed.data;

  if (rooms.has(roomId)) {
    console.log(`Room already exists: ${roomId}`);
    res.status(200).json({ message: "Room already exists." });
    return;
  }

  rooms.set(roomId, null);
  scheduleRoomCleanup(roomId, UNUSED_ROOM_TTL_MS);

console.log(`Room created: ${roomId}`);
  res.status(201).json({ roomId });
});

function canSignal(
  socket: Socket,
  roomId: string,
  targetId: string,
): boolean {
  const members = io.sockets.adapter.rooms.get(roomId);

  return (
    socket.rooms.has(roomId) &&
    members?.has(targetId) === true
  );
}

io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on("room:join", (payload: unknown) => {
    console.log(`Join request from ${socket.id}:`, payload);
    const parsed = joinSchema.safeParse(payload);

    if (!parsed.success) {
      socket.emit("room:error", {
        message: "Invalid room ID.",
      });
      return;
    }

    const { roomId } = parsed.data;

    if (!rooms.has(roomId)) {
      socket.emit("room:error", {
        message: "Room does not exist or has expired.",
      });
      return;
    }

    const members = io.sockets.adapter.rooms.get(roomId);
    const peers = [...(members ?? [])].filter(
      (peerId) => peerId !== socket.id,
    );

    if (!socket.rooms.has(roomId)) {
      const timer = rooms.get(roomId);

      if (timer) {
        clearTimeout(timer);
      }

      rooms.set(roomId, null);
      socket.join(roomId);

      // Notify existing peers about the newcomer.
      socket.to(roomId).emit("peer:joined", {
        roomId,
        peerId: socket.id,
      });
    }

    // The joining client can establish WebRTC connections
    // with these existing peers.
    socket.emit("room:peers", {
      roomId,
      peers,
    });
  });

  socket.on("webrtc:offer", (payload: unknown) => {
    const parsed = signalSchema.safeParse(payload);

    if (!parsed.success) return;

    const { roomId, targetId, description } = parsed.data;

    if (!canSignal(socket, roomId, targetId)) return;

    io.to(targetId).emit("webrtc:offer", {
      roomId,
      from: socket.id,
      description,
    });
  });

  socket.on("webrtc:answer", (payload: unknown) => {
    const parsed = signalSchema.safeParse(payload);

    if (!parsed.success) return;

    const { roomId, targetId, description } = parsed.data;

    if (!canSignal(socket, roomId, targetId)) return;

    io.to(targetId).emit("webrtc:answer", {
      roomId,
      from: socket.id,
      description,
    });
  });

  socket.on("webrtc:ice-candidate", (payload: unknown) => {
    const parsed = candidateSchema.safeParse(payload);

    if (!parsed.success) return;

    const { roomId, targetId, candidate } = parsed.data;

    if (!canSignal(socket, roomId, targetId)) return;

    io.to(targetId).emit("webrtc:ice-candidate", {
      roomId,
      from: socket.id,
      candidate,
    });
  });

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      const members = io.sockets.adapter.rooms.get(roomId);

      if (rooms.has(roomId) && members?.size === 1) {
        scheduleRoomCleanup(roomId, EMPTY_ROOM_TTL_MS);
      }
    }
  });

  socket.on("disconnect", () => {
    console.log(`Disconnected: ${socket.id}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});