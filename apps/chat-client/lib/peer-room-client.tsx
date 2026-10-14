
import { Peer, type DataConnection } from "peerjs";
import { io, type Socket } from "socket.io-client";
import { z } from "zod";

const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY_MESSAGES = 2000;

const chatMessageSchema = z.object({
  id: z.string().min(1).max(128),
  senderId: z.string().min(1).max(128),
  senderSeq: z.number().int().positive(),
  lamport: z.number().int().nonnegative(),
  text: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  createdAt: z.number().int().nonnegative(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

const wireMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("history:snapshot"),
    messages: z.array(chatMessageSchema).max(MAX_HISTORY_MESSAGES),
  }),
  z.object({
    type: z.literal("chat:message"),
    message: chatMessageSchema,
  }),
]);

type WireMessage = z.infer<typeof wireMessageSchema>;

const roomPeersSchema = z.object({
  roomId: z.string(),
  peers: z.array(z.string()),
});

const peerEventSchema = z.object({
  roomId: z.string(),
  peerId: z.string(),
});

type RoomStatus =
  | "starting"
  | "connecting"
  | "in-room"
  | "error"
  | "closed";

type PeerRoomOptions = {
  roomId: string;
  onMessages: (messages: ChatMessage[]) => void;
  onPeers: (peerIds: string[]) => void;
  onStatus: (status: RoomStatus, detail?: string) => void;
};

function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.lamport !== b.lamport) {
    return a.lamport - b.lamport;
  }

  if (a.senderId !== b.senderId) {
    return a.senderId < b.senderId ? -1 : 1;
  }

  if (a.senderSeq !== b.senderSeq) {
    return a.senderSeq - b.senderSeq;
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class PeerRoomClient {
  private readonly roomId: string;
  private readonly options: PeerRoomOptions;

  private peer: Peer | null = null;
  private socket: Socket | null = null;
  private myPeerId: string | null = null;

  private connections = new Map<string, DataConnection>();
  private knownPeers = new Set<string>();

  // Content is in memory only. No localStorage or database.
  private messages = new Map<string, ChatMessage>();

  // Remember IDs even if their messages fall outside the history window.
  // This prevents old messages from circulating forever.
  private seenMessageIds = new Set<string>();

  private senderSeq = 0;
  private lamport = 0;
  private stopped = false;

  constructor(options: PeerRoomOptions) {
    this.roomId = options.roomId;
    this.options = options;
  }

  get selfId(): string | null {
    return this.myPeerId;
  }

  start(): void {
    if (this.peer || this.stopped) return;

    this.options.onStatus("starting");

    const host =
      process.env.NEXT_PUBLIC_PEER_HOST ?? "localhost";

    const port = Number(
      process.env.NEXT_PUBLIC_PEER_PORT ?? "9000",
    );

    const path =
      process.env.NEXT_PUBLIC_PEER_PATH ?? "/peerjs";

    const secure =
      process.env.NEXT_PUBLIC_PEER_SECURE === "true";

    const peer = new Peer(undefined, {
      host,
      port,
      path,
      secure,
      debug: 2,
    });

    this.peer = peer;

    // Register this before initiating connections so incoming
    // connections are handled as soon as PeerJS reports them.
    peer.on("connection", (connection) => {
      this.attachConnection(connection);
    });

    peer.on("open", (peerId) => {
      if (this.stopped) return;

      this.myPeerId = peerId;
      this.connectToRoomCoordinator(peerId);
    });

    peer.on("disconnected", () => {
      if (!this.stopped) {
        this.options.onStatus(
          "connecting",
          "PeerJS signaling disconnected; existing data channels may remain open.",
        );
      }
    });

    peer.on("error", (error) => {
      console.error("PeerJS error:", error.type, error.message);

      if (!this.stopped) {
        this.options.onStatus("error", error.message);
      }
    });
  }

  private connectToRoomCoordinator(peerId: string): void {
    const serverUrl =
      process.env.NEXT_PUBLIC_SIGNALING_URL ??
      "http://localhost:4000";

    const socket = io(serverUrl);
    this.socket = socket;

    socket.on("connect", () => {
      socket.emit("room:join", {
        roomId: this.roomId,
        peerId,
      });
    });

    socket.on("room:peers", (raw: unknown) => {
      const result = roomPeersSchema.safeParse(raw);
      console.log("room:peers", raw, result);

      if (!result.success || result.data.roomId !== this.roomId) {
        return;
      }

      this.knownPeers = new Set(
        result.data.peers.filter((id) => id !== this.myPeerId),
      );

      this.publishPeers();

      for (const remotePeerId of this.knownPeers) {
        this.ensureConnection(remotePeerId);
      }

      this.options.onStatus("in-room");
    });

    socket.on("peer:joined", (raw: unknown) => {
      const result = peerEventSchema.safeParse(raw);
      console.log("peer:joined", raw, result);

      if (!result.success || result.data.roomId !== this.roomId) {
        return;
      }

      const { peerId: remotePeerId } = result.data;

      if (remotePeerId === this.myPeerId) return;

      this.knownPeers.add(remotePeerId);
      this.publishPeers();
      this.ensureConnection(remotePeerId);
    });

    socket.on("peer:left", (raw: unknown) => {
      const result = peerEventSchema.safeParse(raw);
      console.log("peer:left", raw, result);

      if (!result.success || result.data.roomId !== this.roomId) {
        return;
      }

      const { peerId: remotePeerId } = result.data;

      this.knownPeers.delete(remotePeerId);

      this.connections.get(remotePeerId)?.close();
      this.publishPeers();
    });

    socket.on(
      "room:error",
      (payload: { message?: string }) => {
        this.options.onStatus(
          "error",
          payload?.message ?? "Unable to join the room.",
        );
      },
    );

    socket.on("connect_error", (error) => {
      this.options.onStatus("connecting", error.message);
    });

    socket.on("disconnect", () => {
      if (!this.stopped) {
        this.options.onStatus(
          "connecting",
          "Disconnected from the room coordinator.",
        );
      }
    });
  }

  private ensureConnection(remotePeerId: string): void {
    if (!this.peer || !this.myPeerId) return;
    if (remotePeerId === this.myPeerId) return;

    // Deterministic initiator rule: only the smaller ID initiates.
    // JavaScript string comparison is consistent across browsers.
    if (this.myPeerId > remotePeerId) return;

    // This map also prevents duplicate connection attempts.
    if (this.connections.has(remotePeerId)) return;

    const connection = this.peer.connect(remotePeerId, {
      label: `chat-${this.roomId}`,
      metadata: {
        roomId: this.roomId,
        protocolVersion: 1,
      },
      serialization: "json",
      reliable: true,
    });

    this.attachConnection(connection);
  }

  private attachConnection(connection: DataConnection): void {
    const metadata = connection.metadata as
      | { roomId?: unknown }
      | undefined;

    // Useful protocol sanity check, but not strong authentication.
    if (metadata?.roomId !== this.roomId) {
      connection.close();
      return;
    }

    const remotePeerId = connection.peer;
    const existing = this.connections.get(remotePeerId);

    console.log('Attaching connection to peer', remotePeerId, 'existing:', existing);

    if (existing && existing !== connection) {
      connection.close();
      return;
    }

    this.connections.set(remotePeerId, connection);
    this.knownPeers.add(remotePeerId);
    this.publishPeers();

    connection.on("open", () => {
      if (this.stopped) return;

      // Send the current transcript directly to this peer.
      connection.send({
        type: "history:snapshot",
        messages: this.getMessages(),
      } satisfies WireMessage);
    });

    connection.on("data", (raw: unknown) => {
      this.handleWireMessage(remotePeerId, raw);
    });

    connection.on("close", () => {
      if (this.connections.get(remotePeerId) === connection) {
        this.connections.delete(remotePeerId);
      }
    });

    connection.on("error", (error) => {
      console.warn(
        `Data connection error with ${remotePeerId}:`,
        error,
      );
    });
  }

  private handleWireMessage(
    sourcePeerId: string,
    raw: unknown,
  ): void {
    const result = wireMessageSchema.safeParse(raw);

    if (!result.success) {
      console.warn("Ignoring invalid peer message.");
      return;
    }

    const wireMessage = result.data;
    let added: ChatMessage[];

    if (wireMessage.type === "history:snapshot") {
      added = this.mergeMessages(wireMessage.messages);
    } else {
      added = this.mergeMessages([wireMessage.message]);
    }

    // Gossip newly discovered messages to everyone except the
    // sender. Message IDs prevent them circulating indefinitely.
    this.broadcastMessages(added, sourcePeerId);
  }

  private mergeMessages(incoming: ChatMessage[]): ChatMessage[] {
    const added: ChatMessage[] = [];

    for (const message of incoming) {
      if (this.seenMessageIds.has(message.id)) continue;

      this.seenMessageIds.add(message.id);
      this.messages.set(message.id, message);
      this.lamport = Math.max(this.lamport, message.lamport);
      added.push(message);
    }

    // Keep a bounded transcript for this short-chat prototype.
    if (this.messages.size > MAX_HISTORY_MESSAGES) {
      const ordered = this.getMessages();

      this.messages = new Map(
        ordered
          .slice(-MAX_HISTORY_MESSAGES)
          .map((message) => [message.id, message]),
      );
    }

    if (added.length > 0) {
      this.options.onMessages(this.getMessages());
    }

    return added;
  }

  private getMessages(): ChatMessage[] {
    return [...this.messages.values()].sort(compareMessages);
  }

  private broadcastMessages(
    messages: ChatMessage[],
    excludedPeerId?: string,
  ): void {
    for (const message of messages) {
      for (const [remotePeerId, connection] of this.connections) {
        if (remotePeerId === excludedPeerId || !connection.open) {
          continue;
        }

        try {
          connection.send({
            type: "chat:message",
            message,
          } satisfies WireMessage);
        } catch (error) {
          console.warn("Could not send message to peer:", error);
        }
      }
    }
  }

  sendMessage(text: string): void {
    const normalizedText = text.trim();

    if (!normalizedText) return;

    if (normalizedText.length > MAX_MESSAGE_LENGTH) {
      throw new Error(
        `Messages must be at most ${MAX_MESSAGE_LENGTH} characters.`,
      );
    }

    if (!this.myPeerId || this.stopped) {
      throw new Error("The chat client is not ready.");
    }

    this.lamport += 1;
    this.senderSeq += 1;

    const message: ChatMessage = {
      id: crypto.randomUUID(),
      senderId: this.myPeerId,
      senderSeq: this.senderSeq,
      lamport: this.lamport,
      text: normalizedText,
      createdAt: Date.now(),
    };

    const added = this.mergeMessages([message]);
    this.broadcastMessages(added);
  }

  private publishPeers(): void {
    this.options.onPeers([...this.knownPeers]);
  }

  destroy(): void {
    if (this.stopped) return;

    this.stopped = true;

    this.socket?.disconnect();

    for (const connection of this.connections.values()) {
      connection.close();
    }

    this.connections.clear();
    this.peer?.destroy();
    this.peer = null;

    this.options.onStatus("closed");
  }
}