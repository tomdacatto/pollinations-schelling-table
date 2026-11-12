import assert from "node:assert/strict";
import test from "node:test";
import { choose, currentPrompt, join, newRoom, ROUND_MS, say, start, tick, view, winners } from "./src/game.js";

const rand = () => 0.5;
const table = (n = 3, rounds = 2) => {
    const room = newRoom("ABCD", { rounds }, 0, rand);
    const tokens = Array.from({ length: n }, (_, i) => join(room, `p${i + 1}`, `t${i + 1}`).token);
    return { room, tokens };
};

test("joining: names are trimmed, unique and limited, and only in the lobby", () => {
    const room = newRoom("ABCD", { maxPlayers: 2 }, 0, rand);
    assert.equal(join(room, "  Ann ", "a").name, "Ann");
    assert.match(join(room, "ann", "b").error, /taken/);
    assert.match(join(room, "  ", "b").error, /name/);
    join(room, "Bob", "b");
    assert.match(join(room, "Cy", "c").error, /full/);
});

test("the game needs two players and starts a round with a prompt", () => {
    const room = newRoom("ABCD", {}, 0, rand);
    join(room, "a", "ta");
    assert.match(start(room, "ta", 0).error, /2 players/);
    join(room, "b", "tb");
    assert.match(start(room, "nope", 0).error, /Unknown token/);
    assert.deepEqual(start(room, "ta", 10), { ok: true });
    assert.equal(room.status, "playing");
    assert.equal(room.round, 1);
    assert.equal(room.deadline, 10 + ROUND_MS);
    assert.equal(currentPrompt(room).options.length, 6);
});

test("everyone choosing the same option scores n-1 each, and a split scores per match", () => {
    const { room, tokens } = table(3);
    start(room, tokens[0], 0);
    const [a, b, c] = currentPrompt(room).options;
    choose(room, tokens[0], a, 1);
    choose(room, tokens[1], a, 1);
    assert.equal(room.round, 1);
    choose(room, tokens[2], b, 1);
    assert.equal(room.round, 2);
    assert.deepEqual(
        room.players.map((p) => p.score),
        [1, 1, 0],
    );
    const next = currentPrompt(room).options;
    for (const t of tokens) choose(room, t, next[0], 2);
    assert.equal(room.status, "over");
    assert.deepEqual(
        room.players.map((p) => p.score),
        [3, 3, 2],
    );
    assert.deepEqual(winners(room), ["p1", "p2"]);
    assert.equal(room.log.length, 2);
    assert.equal(c.length > 0, true);
});

test("choices are validated, case-insensitive, and only once per round", () => {
    const { room, tokens } = table(2);
    start(room, tokens[0], 0);
    const option = currentPrompt(room).options[0];
    assert.match(choose(room, tokens[0], "nonsense", 1).error, /Choose one of/);
    assert.deepEqual(choose(room, tokens[0], option.toUpperCase(), 1), { ok: true });
    assert.match(choose(room, tokens[0], option, 1).error, /already/);
    assert.match(choose(room, "bad", option, 1).error, /Unknown token/);
});

test("saying is once per round, short, and visible to everyone", () => {
    const { room, tokens } = table(2);
    start(room, tokens[0], 0);
    assert.deepEqual(say(room, tokens[0], "x".repeat(500), 1), { ok: true });
    assert.equal(room.said.p1.length, 140);
    assert.match(say(room, tokens[0], "again", 1).error, /already/);
    assert.match(say(room, tokens[1], "   ", 1).error, /Say something/);
    assert.equal(view(room, undefined, 1).said_this_round.p1.length, 140);
});

test("a round that runs out of time is scored without the players who did not choose", () => {
    const { room, tokens } = table(3);
    start(room, tokens[0], 0);
    const option = currentPrompt(room).options[0];
    choose(room, tokens[0], option, 1);
    choose(room, tokens[1], option, 1);
    tick(room, ROUND_MS + 1);
    assert.equal(room.round, 2);
    assert.deepEqual(
        room.players.map((p) => p.score),
        [1, 1, 0],
    );
    assert.equal(room.log[0].chose.p3, null);
    tick(room, ROUND_MS * 5);
    assert.equal(room.status, "over");
});

test("the public view hides choices until the round is scored; a token adds what to do next", () => {
    const { room, tokens } = table(2);
    start(room, tokens[0], 0);
    const option = currentPrompt(room).options[0];
    choose(room, tokens[0], option, 1);
    const open = view(room, undefined, 5000);
    assert.equal(JSON.stringify(open).includes(tokens[0]), false);
    assert.deepEqual(open.players, [
        { name: "p1", score: 0, has_chosen: true },
        { name: "p2", score: 0, has_chosen: false },
    ]);
    assert.equal(open.you, undefined);
    assert.deepEqual(open.waiting_for, ["p2"]);
    assert.equal(open.seconds_left, 115);
    const mine = view(room, tokens[0], 5000);
    assert.equal(mine.you.chosen, option);
    assert.match(mine.next, /Wait for the others/);
    assert.match(view(room, tokens[1], 5000).next, /choose/);
});
