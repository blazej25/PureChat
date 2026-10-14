"use client"; // REQUIRED in App Router

import { useEffect, useState, useRef } from "react";
import { getSocket } from "@/lib/socket";
import Message from "./message";
import { useRouter } from "next/navigation";
import { PeerRoomClient, type ChatMessage } from "@/lib/peer-room-client";

export default function Chat() {
    
    const [input, setInput] = useState("");
    const bottomRef = useRef<HTMLDivElement | null>(null);
    const clientRef = useRef<PeerRoomClient | null>(null);

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [peers, setPeers] = useState<string[]>([]);
    const [status, setStatus] = useState("starting");

    useEffect(() => {
        const roomId = window.location.pathname.substring(1);
        const client = new PeerRoomClient({
            roomId: roomId,
            onMessages: setMessages,
            onPeers: setPeers,
            onStatus: (nextStatus, detail) => {
                setStatus(
                detail ? `${nextStatus}: ${detail}` : nextStatus,
                );
            },
        });

        clientRef.current = client;
        client.start();

        return () => {
        client.destroy();

        if (clientRef.current === client) {
            clientRef.current = null;
        }
        };
    }, []);

    useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
    }, [messages]);

    function sendMessage() {
        if (!input.trim()) return;

        try {
            clientRef.current?.sendMessage(input);
            setInput("");
        } catch (error) {
            console.error("Failed to send message:", error);
        }
    }

    const handleEnter = (e: any) => {
        if (e.key === "Enter") {
            sendMessage();
        }
    }

    return <div className="w-screen h-screen flex flex-row justify-center bg-amber-50">
        <div className="flex flex-col items-center h-full w-1/2 gap-5 p-5">

            <div className="flex-1 flex-col w-full overflow-y-auto no-scrollbar scroll-smooth scroll-m-0 space-y-2 p-5 border-4 border-gray-900 rounded-2xl">
                <div className="flex flex-col justify-end min-h-full space-y-2 gap-2">
                    {messages.map(message => (
                        <Message key={message.id} message={message.text} user={message.senderId}/>
                    ))}
                
                    <div ref={bottomRef}/>
                </div>
            </div>

            <div className="flex flex-row gap-3 p-3 w-full items-center bg-amber-50">
                <input 
                    value={input} 
                    className="flex-1 py-1 px-3 w-full rounded-3xl border-4 border-gray-900 text-gray-900" 
                    onChange={e => setInput(e.target.value)} onKeyDown={(e) => handleEnter(e)}
                />
                <button onClick={sendMessage} className="bg-black rounded-3xl w-1/12 py-1 px-3">Send</button>
            </div>
        </div>
    </div>;
}