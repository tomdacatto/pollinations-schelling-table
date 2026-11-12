import assert from "node:assert/strict";
import test from "node:test";
import { mcpClient, playerTools, roundMessage, runAgent, takeTurn } from "./agent.js";

const mcpTools = [
    { name: "create_room", description: "c", inputSchema: { type: "object", properties: {} } },
    {
        name: "choose",
        description: "pick",
        inputSchema: {
            type: "object",
            properties: { room: { type: "string" }, token: { type: "string" }, option: { type: "string" } },
            required: ["room", "token", "option"],
        },
    },
    {
        name: "get_state",
        description: "state",
        inputSchema: { type: "object", properties: { room: {}, token: {} }, required: ["room"] },
    },
];

test("the tools offered to a model are the player tools, with the room and the token left out", () => {
    const tools = playerTools(mcpTools);
    assert.deepEqual(
        tools.map((t) => t.function.name),
        ["choose", "get_state"],
    );
    assert.deepEqual(Object.keys(tools[0].function.parameters.properties), ["option"]);
    assert.deepEqual(tools[0].function.parameters.required, ["option"]);
});

test("the round message carries the prompt, options, what was said, the last round and the scores", () => {
    const text = roundMessage({
        round: 2,
        rounds: 3,
        prompt: "Pick a colour.",
        options: ["red", "blue"],
        said_this_round: { Ann: "red!" },
        history: [{ prompt: "Pick an animal.", chose: { Ann: "cat", Bob: null } }],
        players: [
            { name: "Ann", score: 1 },
            { name: "Bob", score: 0 },
        ],
    });
    for (const part of ["Round 2 of 3", "red, blue", 'Ann: "red!"', "Bob chose nothing", "Ann 1, Bob 0"])
        assert.ok(text.includes(part), part);
});

test("a turn fills in the room and token, answers every tool call, and stops once the model has chosen", async () => {
    const calls = [];
    const replies = [
        { content: "", tool_calls: [{ id: "1", function: { name: "get_state", arguments: "{}" } }] },
        { content: "", tool_calls: [{ id: "2", function: { name: "choose", arguments: '{"option":"red"}' } }] },
        { content: "never asked" },
    ];
    const messages = [];
    const chose = await takeTurn({
        messages,
        tools: [],
        chat: async () => replies.shift(),
        call: async (name, args) => {
            calls.push([name, args]);
            return { ok: true };
        },
        room: "ABCD",
        token: "t",
        maxTurns: 6,
    });
    assert.equal(chose, true);
    assert.deepEqual(calls, [
        ["get_state", { room: "ABCD", token: "t" }],
        ["choose", { option: "red", room: "ABCD", token: "t" }],
    ]);
    assert.equal(replies.length, 1);
    assert.deepEqual(
        messages.map((m) => m.role),
        ["assistant", "tool", "assistant", "tool"],
    );
});

test("a model that never chooses is counted out after its turns, and bad tool arguments do not crash", async () => {
    let seen = 0;
    const chose = await takeTurn({
        messages: [],
        tools: [],
        chat: async () => ({
            content: "",
            tool_calls: [{ id: "x", function: { name: "say", arguments: "{not json" } }],
        }),
        call: async (name, args) => {
            seen++;
            assert.deepEqual(args, { room: "R", token: "t" });
            return { error: "no" };
        },
        room: "R",
        token: "t",
        maxTurns: 2,
    });
    assert.equal(chose, false);
    assert.equal(seen, 2);
});

test("an agent takes one turn per round and stops when the game is over", async () => {
    const states = [
        {
            status: "playing",
            round: 1,
            rounds: 2,
            prompt: "P1",
            options: ["a"],
            history: [],
            players: [],
            you: { chosen: null },
        },
        {
            status: "playing",
            round: 1,
            rounds: 2,
            prompt: "P1",
            options: ["a"],
            history: [],
            players: [],
            you: { chosen: "a" },
        },
        {
            status: "playing",
            round: 2,
            rounds: 2,
            prompt: "P2",
            options: ["a"],
            history: [],
            players: [],
            you: { chosen: null },
        },
        { status: "over", players: [] },
    ];
    let chats = 0;
    const events = [];
    const final = await runAgent({
        name: "m",
        room: "R",
        token: "t",
        tools: [],
        pollMs: 1,
        onEvent: (e) => events.push(e.kind),
        chat: async () => {
            chats++;
            return {
                content: "",
                tool_calls: [{ id: String(chats), function: { name: "choose", arguments: '{"option":"a"}' } }],
            };
        },
        call: async (name) => (name === "get_state" ? states.shift() : { ok: true }),
    });
    assert.equal(final.status, "over");
    assert.equal(chats, 2);
    assert.deepEqual(events, ["tool", "tool"]);
});

test("the MCP client reads JSON results, turns isError into {error}, and throws on protocol errors", async () => {
    const answers = [
        { result: { content: [{ type: "text", text: '{"a":1}' }] } },
        { result: { isError: true, content: [{ type: "text", text: "bad" }] } },
        { error: { message: "Method not found" } },
    ];
    const sent = [];
    const fetchImpl = async (_url, init) => {
        sent.push(JSON.parse(init.body));
        return { ok: true, json: async () => answers.shift() };
    };
    const client = mcpClient("https://x/mcp", fetchImpl);
    assert.deepEqual(await client.call("get_state", { room: "R" }), { a: 1 });
    assert.deepEqual(await client.call("choose", {}), { error: "bad" });
    await assert.rejects(client.tools(), /Method not found/);
    assert.equal(sent[0].method, "tools/call");
    assert.equal(sent[0].params.name, "get_state");
});
