import { z } from "zod";

export const createRoomSchema = z.object({
  roomId: z.string().min(1).max(128),
});

export const joinSchema = z.object({
  roomId: z.string().min(1).max(128),
});

export const signalSchema = z.object({
  roomId: z.string().min(1).max(128),
  targetId: z.string().min(1).max(128),
  description: z.object({
    type: z.enum(["offer", "answer"]),
    sdp: z.string(),
  }),
});

export const candidateSchema = z.object({
  roomId: z.string().min(1).max(128),
  targetId: z.string().min(1).max(128),
  candidate: z.object({
    candidate: z.string(),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().nullable().optional(),
    usernameFragment: z.string().optional(),
  }),
});
