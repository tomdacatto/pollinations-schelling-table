// Schelling Table: the rules, with no network and no storage, so they can be tested alone.
// Players at a table see the same prompt and six options. They may say one short thing,
// then each picks one option in secret. A player scores one point for every other player who
// picked the same option, so the game is to guess what the others will guess.

export const ROUND_MS = 120_000;
export const MAX_SAY = 140;

export const PROMPTS = [
    { id: "color", text: "Pick a colour.", options: ["red", "blue", "green", "yellow", "black", "white"] },
    { id: "number", text: "Pick a number.", options: ["1", "3", "7", "10", "42", "100"] },
    { id: "city", text: "Pick a city.", options: ["Paris", "London", "Tokyo", "New York", "Berlin", "Rome"] },
    {
        id: "day",
        text: "Pick a day of the week.",
        options: ["Monday", "Wednesday", "Friday", "Saturday", "Sunday", "Tuesday"],
    },
    {
        id: "suit",
        text: "Pick a playing card.",
        options: ["ace of spades", "king of hearts", "queen of hearts", "two of clubs", "joker", "seven of diamonds"],
    },
    { id: "animal", text: "Pick an animal.", options: ["dog", "cat", "lion", "owl", "dolphin", "elephant"] },
    { id: "letter", text: "Pick a letter.", options: ["A", "E", "M", "S", "X", "Z"] },
    { id: "planet", text: "Pick a planet.", options: ["Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Neptune"] },
    { id: "month", text: "Pick a month.", options: ["January", "April", "June", "July", "October", "December"] },
    {
        id: "element",
        text: "Pick a chemical element.",
        options: ["hydrogen", "oxygen", "carbon", "gold", "iron", "helium"],
    },
    { id: "meal", text: "Pick a meal.", options: ["pizza", "sushi", "pasta", "burger", "salad", "soup"] },
    { id: "shape", text: "Pick a shape.", options: ["circle", "square", "triangle", "star", "hexagon", "spiral"] },
];

const shuffled = (list, rand) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};

/** A new table in the lobby. */
export function newRoom(code, { rounds = 5, maxPlayers = 4 } = {}, now, rand = Math.random) {
    const r = Math.min(Math.max(Math.trunc(Number(rounds)) || 5, 1), PROMPTS.length);
    const m = Math.min(Math.max(Math.trunc(Number(maxPlayers)) || 4, 2), 6);
    return {
        code,
        status: "lobby",
        rounds: r,
        maxPlayers: m,
        created: now,
        prompts: shuffled(PROMPTS, rand)
            .slice(0, r)
            .map((p) => p.id),
        players: [],
        round: 0,
        deadline: null,
        said: {},
        chose: {},
        log: [],
    };
}

const fail = (message) => ({ error: message });

/** Adds a player. The token is the player's secret for later calls. */
export function join(room, name, token) {
    const clean = String(name ?? "")
        .trim()
        .slice(0, 20);
    if (!clean) return fail("Give a name of 1 to 20 characters.");
    if (room.status !== "lobby") return fail("The game has already started.");
    if (room.players.length >= room.maxPlayers) return fail(`The table is full (${room.maxPlayers} players).`);
    if (room.players.some((p) => p.name.toLowerCase() === clean.toLowerCase()))
        return fail("That name is taken at this table.");
    room.players.push({ name: clean, token, score: 0 });
    return { name: clean, token };
}

const playerOf = (room, token) => room.players.find((p) => p.token === token);

function beginRound(room, now) {
    room.round += 1;
    room.said = {};
    room.chose = {};
    room.deadline = now + ROUND_MS;
}

/** Starts the game: at least two players. Any player at the table may do it. */
export function start(room, token, now) {
    if (!playerOf(room, token)) return fail("Unknown token for this table.");
    if (room.status !== "lobby") return fail("The game has already started.");
    if (room.players.length < 2) return fail("Wait for at least 2 players to join.");
    room.status = "playing";
    beginRound(room, now);
    return { ok: true };
}

/** The prompt of the round in play. */
export const currentPrompt = (room) => PROMPTS.find((p) => p.id === room.prompts[room.round - 1]);

/** Scores the round, then opens the next one or ends the game. Players who did not choose score nothing. */
function resolve(room, now) {
    const prompt = currentPrompt(room);
    const counts = {};
    for (const option of Object.values(room.chose)) counts[option] = (counts[option] ?? 0) + 1;
    const scores = {};
    for (const player of room.players) {
        const pick = room.chose[player.name];
        const points = pick ? counts[pick] - 1 : 0;
        player.score += points;
        scores[player.name] = points;
    }
    room.log.push({
        round: room.round,
        prompt: prompt.text,
        options: prompt.options,
        chose: Object.fromEntries(room.players.map((p) => [p.name, room.chose[p.name] ?? null])),
        said: { ...room.said },
        scores,
    });
    if (room.round >= room.rounds) {
        room.status = "over";
        room.deadline = null;
    } else beginRound(room, now);
}

/** Lets time pass: a round that ran out of time is scored with what it has. */
export function tick(room, now) {
    while (room.status === "playing" && now >= room.deadline) resolve(room, room.deadline);
}

/** One short message to the table, once per round. */
export function say(room, token, text, now) {
    tick(room, now);
    const player = playerOf(room, token);
    if (!player) return fail("Unknown token for this table.");
    if (room.status !== "playing") return fail("There is no round in play.");
    if (room.said[player.name] !== undefined) return fail("You already spoke this round.");
    const clean = String(text ?? "")
        .trim()
        .slice(0, MAX_SAY);
    if (!clean) return fail("Say something, up to 140 characters.");
    room.said[player.name] = clean;
    return { ok: true };
}

/** A secret choice, once per round. The round is scored as soon as everyone has chosen. */
export function choose(room, token, option, now) {
    tick(room, now);
    const player = playerOf(room, token);
    if (!player) return fail("Unknown token for this table.");
    if (room.status !== "playing") return fail("There is no round in play.");
    if (room.chose[player.name] !== undefined) return fail("You already chose this round.");
    const wanted = String(option ?? "")
        .trim()
        .toLowerCase();
    const match = currentPrompt(room).options.find((o) => o.toLowerCase() === wanted);
    if (!match) return fail(`Choose one of: ${currentPrompt(room).options.join(", ")}.`);
    room.chose[player.name] = match;
    if (room.players.every((p) => room.chose[p.name] !== undefined)) resolve(room, now);
    return { ok: true };
}

/** What a caller may see. Choices stay secret until the round is scored; a token adds the caller's own state. */
export function view(room, token, now) {
    tick(room, now);
    const me = token ? playerOf(room, token) : undefined;
    const prompt = room.status === "playing" ? currentPrompt(room) : undefined;
    const waiting = prompt ? room.players.filter((p) => room.chose[p.name] === undefined).map((p) => p.name) : [];
    const view = {
        room: room.code,
        status: room.status,
        round: room.round,
        rounds: room.rounds,
        players: room.players.map((p) => ({
            name: p.name,
            score: p.score,
            has_chosen: room.chose[p.name] !== undefined,
        })),
        history: room.log,
    };
    if (prompt) {
        view.prompt = prompt.text;
        view.options = prompt.options;
        view.said_this_round = { ...room.said };
        view.waiting_for = waiting;
        view.seconds_left = Math.max(0, Math.round((room.deadline - now) / 1000));
    }
    if (me) {
        view.you = {
            name: me.name,
            score: me.score,
            chosen: room.chose[me.name] ?? null,
            spoke: room.said[me.name] !== undefined,
        };
        view.next =
            room.status === "lobby"
                ? "Wait for others to join, then call start_game."
                : room.status === "over"
                  ? "The game is over."
                  : room.chose[me.name] !== undefined
                    ? "Wait for the others, then call get_state again."
                    : "Optionally say one thing, then call choose.";
    }
    if (room.status === "over") view.winners = winners(room);
    return view;
}

/** The players with the top score. */
export function winners(room) {
    const top = Math.max(...room.players.map((p) => p.score));
    return room.players.filter((p) => p.score === top).map((p) => p.name);
}
