import { mcpClient, playerTools, runAgent } from "./agent.js";
import { CONCURRENCY, DEFAULT_MODELS, MAX_TURNS_PER_ROUND, MCP_URL } from "./config.js";
import { loadModels } from "./models.js";
import { chatMessage, clearSession, completeSignIn, getSession, startSignIn } from "./pollen.js";
import { $, checked, el, money, notice, renderModels, renderSession, SIGN_IN_PROBLEMS } from "./ui.js";

const mcp = mcpClient(MCP_URL);
const state = { models: [], watching: null, timer: null, controller: null, lobby: null };
const short = (name) => name.split("/").pop();
const seed = () => Math.floor(Math.random() * 1e9);

// ---- connecting your own agent
$("#mcp-url").value = MCP_URL;
$("#copy").onclick = () => navigator.clipboard?.writeText(MCP_URL).then(() => ($("#copy").textContent = "Copied"));
$("#snippets").textContent = [
    "# Claude Code",
    `claude mcp add --transport http schelling-table ${MCP_URL}`,
    "",
    "# Codex (~/.codex/config.toml)",
    "[mcp_servers.schelling-table]",
    `url = "${MCP_URL}"`,
    "",
    "# then tell the agent: join a Schelling Table (the code is on this page) and play",
].join("\n");

// ---- watching a table
function stopWatching() {
    clearInterval(state.timer);
    state.timer = null;
}

function watch(code) {
    stopWatching();
    state.watching = code.toUpperCase();
    $("#code").value = state.watching;
    const poll = async () => {
        try {
            const view = await mcp.call("get_state", { room: state.watching });
            if (view.error) {
                renderTable(null, view.error);
                stopWatching();
            } else {
                renderTable(view);
                if (view.status === "over") stopWatching();
            }
        } catch (error) {
            notice(`Could not reach the table: ${error.message}`, "error");
            stopWatching();
        }
    };
    poll();
    state.timer = setInterval(poll, 3000);
}

function renderTable(view, problem) {
    const felt = $("#table");
    felt.hidden = false;
    felt.replaceChildren();
    if (!view) {
        felt.append(el("p", "fine", problem));
        $("#history").replaceChildren();
        return;
    }
    const head =
        view.status === "lobby"
            ? `Table ${view.room}: waiting for players (${view.players.length} seated)`
            : view.status === "over"
              ? `Table ${view.room}: game over. ${view.winners.join(" and ")} won`
              : `Table ${view.room}: round ${view.round} of ${view.rounds}, ${view.seconds_left}s left`;
    felt.append(el("h3", "", head));
    if (view.prompt) {
        felt.append(el("p", "prompt", view.prompt));
        const chips = el("div", "chips");
        for (const option of view.options) chips.append(el("span", "chip", option));
        felt.append(chips);
    }
    const seats = el("div", "seats");
    for (const player of view.players) {
        const seat = el("div", `seat${view.waiting_for?.includes(player.name) ? " thinking" : ""}`);
        seat.append(el("strong", "", player.name), el("span", "score", `${player.score} pt`));
        const said = view.said_this_round?.[player.name];
        if (view.status === "playing") seat.append(el("span", "fine", player.has_chosen ? "has chosen" : "thinking"));
        if (said) seat.append(el("q", "said", said));
        seats.append(seat);
    }
    felt.append(seats);
    renderHistory(view.history);
}

function renderHistory(history) {
    const box = $("#history");
    box.replaceChildren();
    for (const round of [...history].reverse()) {
        const card = el("div", "round");
        card.append(el("h4", "", `Round ${round.round}: ${round.prompt}`));
        const groups = new Map();
        for (const [who, option] of Object.entries(round.chose))
            groups.set(option, [...(groups.get(option) ?? []), who]);
        for (const [option, who] of groups)
            card.append(
                el("p", "", `${option ?? "no choice"}: ${who.map((w) => `${w} (+${round.scores[w]})`).join(", ")}`),
            );
        for (const [who, said] of Object.entries(round.said)) card.append(el("q", "said", `${who}: ${said}`));
        box.append(card);
    }
}

// ---- seating models
function estimate() {
    const names = checked($("#models"));
    const rounds = Number($("#rounds").value);
    const cost = names.reduce((sum, name) => {
        const price = Number(state.models.find((m) => m.name === name)?.pricing?.completionTextTokens ?? 0);
        return sum + rounds * 3500 * price;
    }, 0);
    $("#estimate").textContent =
        names.length >= 2
            ? `${names.length} models, ${rounds} rounds: about ${money(cost)} Pollen (a rough estimate).`
            : "Pick at least two models.";
}

function logLine(event) {
    $("#log-card").hidden = false;
    const text =
        event.kind === "tool"
            ? `${event.agent}, round ${event.round}: ${event.name}(${Object.values(event.args).join(", ")})${event.result.error ? ` failed: ${event.result.error}` : ""}`
            : event.kind === "no-choice"
              ? `${event.agent}, round ${event.round}: did not choose`
              : `${event.agent}, round ${event.round}: ${event.text}`;
    $("#log").append(el("li", event.result?.error || event.kind === "no-choice" ? "bad" : "", text));
}

async function playSeats(seats, tools) {
    state.controller = new AbortController();
    const { signal } = state.controller;
    $("#stop").hidden = false;
    $("#run").disabled = true;
    const agents = seats.map(
        (seat) => () =>
            runAgent({
                name: seat.name,
                room: seat.room,
                token: seat.token,
                tools,
                signal,
                maxTurns: MAX_TURNS_PER_ROUND,
                onEvent: logLine,
                call: (name, args) => mcp.call(name, args),
                chat: (messages, offered) =>
                    chatMessage(seat.model, messages, { tools: offered, signal, seed: seed() }),
            }).catch((error) => {
                if (signal.aborted) return;
                logLine({ agent: seat.name, round: "-", kind: "text", text: `stopped: ${error.message}` });
                if (/sign-in expired|Out of Pollen/.test(error.message)) state.controller.abort();
            }),
    );
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, agents.length) }, async () => {
            while (next < agents.length) await agents[next++]();
        }),
    );
    $("#stop").hidden = true;
    $("#run").disabled = false;
    renderSession();
}

async function openTable() {
    if (!getSession()) return startSignIn();
    const names = checked($("#models"));
    if (names.length < 2) return notice("Pick at least two models.", "error");
    notice(null);
    $("#log").replaceChildren();
    const open = $("#open-seat").checked;
    const created = await mcp.call("create_room", {
        rounds: Number($("#rounds").value),
        max_players: names.length + (open ? 1 : 0),
    });
    if (created.error) return notice(created.error, "error");
    const seats = [];
    for (const model of names) {
        const base = short(model).slice(0, 20);
        const taken = seats.filter((s) => s.name.startsWith(base)).length;
        const joined = await mcp.call("join_room", {
            room: created.room,
            name: taken ? `${base.slice(0, 17)}-${taken + 1}` : base,
        });
        if (joined.error) return notice(joined.error, "error");
        seats.push({ model, room: created.room, name: joined.name, token: joined.token });
    }
    const tools = playerTools(await mcp.tools());
    watch(created.room);
    if (open) {
        state.lobby = { seats, tools };
        $("#begin").hidden = false;
        return notice(
            `Table ${created.room} is open with ${seats.length} models seated. Join it with your agent, then press Start.`,
        );
    }
    await mcp.call("start_game", { room: created.room, token: seats[0].token });
    await playSeats(seats, tools);
}

async function beginLobby() {
    const { seats, tools } = state.lobby;
    state.lobby = null;
    $("#begin").hidden = true;
    const started = await mcp.call("start_game", { room: seats[0].room, token: seats[0].token });
    if (started.error) return notice(started.error, "error");
    notice(null);
    await playSeats(seats, tools);
}

// ---- start
$("#sign-in").onclick = () => startSignIn();
$("#sign-out").onclick = () => {
    clearSession();
    renderSession();
};
$("#run").onclick = () => openTable().catch((error) => notice(error.message, "error"));
$("#begin").onclick = () => beginLobby().catch((error) => notice(error.message, "error"));
$("#stop").onclick = () => state.controller?.abort();
$("#rounds").onchange = estimate;
$("#watch").onclick = () => {
    const code = $("#code").value.trim();
    if (code.length === 4) watch(code);
};

const outcome = completeSignIn();
if (outcome && outcome !== "ok") notice(SIGN_IN_PROBLEMS[outcome], "error");
renderSession();
loadModels()
    .then((models) => {
        state.models = models;
        renderModels($("#models"), models, DEFAULT_MODELS, estimate);
        estimate();
    })
    .catch((error) => notice(`Could not load the model list: ${error.message}`, "error"));
mcp.init().catch(() => {});
