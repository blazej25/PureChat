"use client"

import Image from "next/image";
import Chat from "./[roomId]/page";
import Login from "./login/page";
import { useRouter } from "next/navigation";
import { useState } from "react";

const serverUrl = "http://localhost:4000";

export default function Home() {
  const router = useRouter();
  const [roomId, setRoomId] = useState("");

  const handleClick = async () => {
    if (!roomId.trim()) return;

    const response = await fetch(`${serverUrl}/api/rooms/${roomId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
    });

    console.log(response.status);

    switch (response.status) {
      case 201:
        console.log("Room created successfully, joining...");
        break;
      case 200:
        console.log("Room already exists, joining...");
        break;
      default:
        alert("Something went wrong during room creation. Please try again.");
        return;
    }

    router.push(`${roomId}`);
  };

  return (
    <div className="flex flex-col gap-2 justify-center items-center h-screen w-screen bg-amber-50 text-gray-900">
        <h1 className="text-xl text-gray-900">PureChat</h1>
            <input placeholder="Chat room ID" className="border-2 border-gray-900 px-3 py-1 rounded-2xl" onChange={(e) => setRoomId(e.target.value)}/>
            <button onClick={handleClick} className="bg-gray-900 text-amber-50 px-3 py-1 rounded-2xl border-2 border-gray-900 transition ease-in-out duration-400 hover:bg-amber-50 hover:text-gray-900">
                Enter
            </button>
    </div>
  );
}
