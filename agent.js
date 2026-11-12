// The part of the page that seats a model at a table: an MCP client (JSON-RPC over HTTP) and the loop that
// lets a model play through the table's tools. It takes `chat` and `call` as arguments, so it runs the same
// in the browser and in tests, and the table's rules stay on the server.

const SYSTEM =
    "You are a player at Schelling Table, a game on an MCP server. Everyone at the table sees the same prompt and six options and each player secretly picks one. You score one point for every other player who picks the same option as you, so the goal is to guess what the others will guess. You may say one short thing to the table each round before you choose. Use the tools: say (optional), then choose. Keep your answers short.";

let nextId = 1;

/** A minimal MCP client for a stateless Streamable HTTP server. `call(name, args)` resolves to parsed JSON or {error}. */
export function mcpClient(url, fetchImpl = fetch) {
    const rpc = async (method, params, { notify = false } = {}) => {
        const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: nextId++, method, params };
        const res = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify(body),
        });
        if (notify) return null;
        if (!res.ok) throw new Error(`The MCP server answered ${res.status}.`);
        const reply = await res.json();
        if (reply.error) throw new Error(reply.error.message);
        return reply.result;
    };
    return {
        async init() {
            await rpc("initialize", {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "schelling-table-page", version: "0.1.0" },
            });
            await rpc("notifications/initialized", {}, { notify: true });
        },
        async tools() {
            return (await rpc("tools/list", {})).tools;
        },
        async call(name, args) {
            const result = await rpc("tools/call", { name, arguments: args });
            const text = result.content?.[0]?.text ?? "";
            if (result.isError) return { error: text };
            try {
                return JSON.parse(text);
            } catch {
                return { text };
            }
        },
    };
}

/** The tools a seated model is offered, as OpenAI function tools. The room and the token are filled in for it. */
export function playerTools(mcpTools, names = ["say", "choose", "get_state"]) {
    return mcpTools
        .filter((tool) => names.includes(tool.name))
        .map((tool) => {
            const properties = Object.fromEntries(
                Object.entries(tool.inputSchema.properties ?? {}).filter(([key]) => key !== "room" && key !== "token"),
            );
            const required = (tool.inputSchema.required ?? []).filter((key) => key !== "room" && key !== "token");
            return {
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: { type: "object", properties, required },
                },
            };
        });
}

/** What a model is told when a round opens. */
export function roundMessage(state) {
    const lines = [`Round ${state.round} of ${state.rounds}. ${state.prompt}`, `Options: ${state.options.join(", ")}.`];
    const said = Object.entries(state.said_this_round ?? {});
    if (said.length) lines.push(`Said so far: ${said.map(([who, what]) => `${who}: "${what}"`).join("; ")}`);
    if (state.history.length) {
        const last = state.history.at(-1);
        lines.push(
            `Last round ("${last.prompt}"): ${Object.entries(last.chose)
                .map(([who, option]) => `${who} chose ${option ?? "nothing"}`)
                .join(", ")}.`,
        );
    }
    lines.push(`Scores: ${state.players.map((p) => `${p.name} ${p.score}`).join(", ")}. Choose now.`);
    return lines.join("\n");
}

const sleep = (ms, signal) =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        });
    });

/**
 * One model's turn in one round: it may call tools for a few turns until it has chosen.
 * `chat(messages, tools)` resolves to the reply message; `call(name, args)` runs a table tool.
 */
export async function takeTurn({ messages, tools, chat, call, room, token, maxTurns, onEvent }) {
    for (let turn = 0; turn < maxTurns; turn++) {
        const reply = await chat(messages, tools);
        messages.push({
            role: "assistant",
            content: reply.content ?? "",
            ...(reply.tool_calls && { tool_calls: reply.tool_calls }),
        });
        if (!reply.tool_calls?.length) {
            if (reply.content) onEvent?.({ kind: "text", text: reply.content });
            return false;
        }
        let chose = false;
        for (const toolCall of reply.tool_calls) {
            let args;
            try {
                args = JSON.parse(toolCall.function.arguments || "{}");
            } catch {
                args = {};
            }
            const result = await call(toolCall.function.name, { ...args, room, token });
            if (toolCall.function.name === "choose" && !result.error) chose = true;
            onEvent?.({ kind: "tool", name: toolCall.function.name, args, result });
            messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) });
        }
        if (chose) return true;
    }
    return false;
}

/** Plays a whole game as one player: take a turn when a round opens, otherwise wait. Resolves to the final state. */
export async function runAgent({ name, room, token, chat, call, tools, signal, onEvent, maxTurns = 6, pollMs = 3000 }) {
    const messages = [{ role: "system", content: SYSTEM }];
    let lastRound = 0;
    while (!signal?.aborted) {
        const state = await call("get_state", { room, token });
        if (state.error) throw new Error(state.error);
        if (state.status === "over") return state;
        if (state.status === "playing" && state.round !== lastRound && !state.you.chosen) {
            lastRound = state.round;
            messages.push({ role: "user", content: roundMessage(state) });
            const chose = await takeTurn({
                messages,
                tools,
                chat,
                call,
                room,
                token,
                maxTurns,
                onEvent: (event) => onEvent?.({ agent: name, round: state.round, ...event }),
            });
            if (!chose) onEvent?.({ agent: name, round: state.round, kind: "no-choice" });
        } else await sleep(pollMs, signal);
    }
    return null;
}
