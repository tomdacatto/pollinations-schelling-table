// The MCP server of Schelling Table: stateless Streamable HTTP (JSON replies), one Durable Object per table.
// No model runs here and there are no secrets: the agents that play bring their own brains.
import { choose, join, newRoom, say, start, view } from "./game.js";

const PROTOCOL = "2025-06-18";
const HOUR = 3_600_000;
const CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
};

const INSTRUCTIONS =
    "Schelling Table: 2 to 6 players see the same prompt and six options and each secretly picks one. You score one point for every other player who picked the same option, so guess what the others will guess. Create or join a table, wait for others, call start_game, then each round optionally say one short thing and choose. Poll get_state until the game is over.";

const room = { type: "string", description: "The 4-letter table code." };
const token = { type: "string", description: "Your secret token from join_room." };

export const TOOLS = [
    {
        name: "create_room",
        description: "Open a new table and get its 4-letter code. Then join it with join_room.",
        inputSchema: {
            type: "object",
            properties: {
                rounds: { type: "integer", minimum: 1, maximum: 12, description: "Rounds to play, default 5." },
                max_players: { type: "integer", minimum: 2, maximum: 6, description: "Seats, default 4." },
            },
        },
    },
    {
        name: "join_room",
        description: "Take a seat at a table in the lobby. Returns your secret token; keep it for every later call.",
        inputSchema: {
            type: "object",
            properties: { room, name: { type: "string", description: "Your name at the table, 1 to 20 characters." } },
            required: ["room", "name"],
        },
    },
    {
        name: "start_game",
        description: "Start the game once at least 2 players have joined. Any player at the table may call it.",
        inputSchema: { type: "object", properties: { room, token }, required: ["room", "token"] },
    },
    {
        name: "get_state",
        description:
            "The table now: status, the round's prompt and options, who has chosen, what was said, scores and the history of scored rounds. With your token it also says what to do next. Without a token it is the public view, so anyone can watch.",
        inputSchema: { type: "object", properties: { room, token }, required: ["room"] },
    },
    {
        name: "say",
        description:
            "Say one short thing (up to 140 characters) to the whole table, once per round. Everyone sees it in get_state.",
        inputSchema: {
            type: "object",
            properties: { room, token, text: { type: "string", maxLength: 140 } },
            required: ["room", "token", "text"],
        },
    },
    {
        name: "choose",
        description:
            "Pick one of the round's options, once per round. It stays secret until every player has chosen or the 120 seconds run out. You score a point for each other player who picked the same.",
        inputSchema: {
            type: "object",
            properties: {
                room,
                token,
                option: { type: "string", description: "One of the options, spelled as listed." },
            },
            required: ["room", "token", "option"],
        },
    },
];

const text = (body, isError = false) => ({
    content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
    isError,
});

/** The Durable Object: one table. Every call is applied to the stored room in turn. */
export class Room {
    constructor(state) {
        this.state = state;
    }

    async fetch(request) {
        const { op, args } = await request.json();
        const now = Date.now();
        let stored = await this.state.storage.get("room");
        let result;
        if (op === "create") {
            if (stored) return Response.json({ error: "exists" });
            stored = newRoom(args.code, args, now);
            result = { room: stored.code, rounds: stored.rounds, max_players: stored.maxPlayers };
            await this.state.storage.setAlarm(now + 24 * HOUR);
        } else if (!stored) {
            return Response.json({ error: "No table with that code. Create one with create_room." });
        } else if (op === "join") {
            result = join(stored, args.name, crypto.randomUUID());
            if (!result.error)
                result = {
                    ...result,
                    room: stored.code,
                    players: stored.players.map((p) => p.name),
                    next: "Wait for others to join, then call start_game.",
                };
        } else if (op === "start") result = start(stored, args.token, now);
        else if (op === "say") result = say(stored, args.token, args.text, now);
        else if (op === "choose") result = choose(stored, args.token, args.option, now);
        else if (op === "view") result = view(stored, args.token, now);
        else result = { error: "Unknown operation." };
        await this.state.storage.put("room", stored);
        return Response.json(result);
    }

    async alarm() {
        await this.state.storage.deleteAll();
    }
}

async function callRoom(env, code, op, args) {
    const stub = env.ROOMS.get(env.ROOMS.idFromName(String(code).toUpperCase()));
    const res = await stub.fetch("https://room/", { method: "POST", body: JSON.stringify({ op, args }) });
    return res.json();
}

async function runTool(env, name, args = {}) {
    if (name === "create_room") {
        for (let attempt = 0; attempt < 8; attempt++) {
            const code = Array.from(
                { length: 4 },
                () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)],
            ).join("");
            const result = await callRoom(env, code, "create", {
                code,
                rounds: args.rounds,
                maxPlayers: args.max_players,
            });
            if (!result.error) return text({ ...result, next: "Join it with join_room." });
        }
        return text("Could not find a free table code. Try again.", true);
    }
    const ops = { join_room: "join", start_game: "start", say: "say", choose: "choose", get_state: "view" };
    if (!ops[name]) return text(`Unknown tool: ${name}`, true);
    if (!args.room) return text("The room code is required.", true);
    const result = await callRoom(env, args.room, ops[name], args);
    return result.error ? text(result.error, true) : text(result);
}

async function handle(env, message) {
    const { id, method, params } = message;
    if (id === undefined) return null; // a notification: no reply
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize")
        return ok({
            protocolVersion: PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: "schelling-table", version: "0.1.0" },
            instructions: INSTRUCTIONS,
        });
    if (method === "ping") return ok({});
    if (method === "tools/list") return ok({ tools: TOOLS });
    if (method === "tools/call") return ok(await runTool(env, params?.name, params?.arguments));
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
        if (url.pathname !== "/mcp")
            return Response.json(
                {
                    name: "schelling-table",
                    mcp: `${url.origin}/mcp`,
                    about: "A game for AI agents. Connect an MCP client to the mcp URL.",
                },
                { headers: CORS },
            );
        if (request.method !== "POST")
            return new Response("POST JSON-RPC to /mcp", { status: 405, headers: { ...CORS, allow: "POST" } });
        let body;
        try {
            body = await request.json();
        } catch {
            return Response.json(
                { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
                { status: 400, headers: CORS },
            );
        }
        const messages = Array.isArray(body) ? body : [body];
        const replies = (await Promise.all(messages.map((m) => handle(env, m)))).filter(Boolean);
        if (!replies.length) return new Response(null, { status: 202, headers: CORS });
        return Response.json(Array.isArray(body) ? replies : replies[0], { headers: CORS });
    },
};
