"use client"; // REQUIRED in App Router

import { useEffect, useState, useRef } from "react";
import { getSocket } from "@/lib/socket";
import Message from "../../components/message";
import { useRouter } from "next/navigation";

interface Message {
    id: number;
    message: string;
    sender: string;
}

export default function Chat() {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const bottomRef = useRef<HTMLDivElement | null>(null);
    const router = useRouter();

    useEffect(() => {
        const socket = getSocket();

        socket.connect();

        socket.emit("room:join", { roomId: window.location.pathname.substring(1) });

        socket.on("room:error", (data: { message: string }) => {
            alert(data.message);
            router.push("/");
        });

        socket.on("room:peers", (data: { roomId: string; peers: string[] }) => {
            console.log(`Peers in room ${data.roomId}:`, data.peers);
        });

        socket.on("peer:joined", (data: { roomId: string; peerId: string }) => {
            console.log(`Peer ${data.peerId} joined room ${data.roomId}`);
        });

        return () => {
            socket.off("message");
            socket.disconnect();
        };
    }, []);

    useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
    }, [messages]);


    const sendMessage = () => {
        if (!input.trim()) return;

        const socket = getSocket();

        //socket.emit("message", input)
        setInput("");
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
                        <Message key={message.id} message={message.message} user={(myUsername == message.sender) ? "You" : message.sender}/>
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