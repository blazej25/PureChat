"use client"

export default function Message({message, user}: {message: string, user: string}) {
    return <div className={(user === "You") ? "flex flex-col gap-0.5 w-full items-end" : "flex flex-col gap-0.5 w-full"}>
        <div className="text-gray-700 text-xs max-w-1/3 w-fit mx-3">{user}</div>
        <div className="text-amber-50 bg-gray-900 text-wrap rounded-2xl px-3 py-1 max-w-1/3 w-fit">{message}</div>
    </div>
}