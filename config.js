// What a visitor's key may spend and for how long. Pollen is per visitor.
// A table of four small models playing five rounds costs a few thousandths of a Pollen.
export const BUDGET = 0.5;
export const EXPIRY_DAYS = 1;

// The app's publishable App Key (pk_...), sent as client_id so the consent screen names the app and usage is
// attributed to it. Its redirect URI must be exactly this page's address. Empty until the key is created.
export const APP_KEY = "pk_vY18Q4rFZyYB7BEW";

// The MCP server of the game (a Cloudflare Worker, free plan). Any MCP client can use it.
export const MCP_URL = "https://schelling-table.schelling-table-server.workers.dev/mcp";

// Models seated at the first table, when the live list has them. All are free for every visitor.
export const DEFAULT_MODELS = [
    "openai/gpt-5.4-nano",
    "deepseek/deepseek-v4.1-flash",
    "z-ai/glm-5.3-flash",
    "minimax/minimax-m3.1-flash",
];

// Safety stops for one agent.
export const MAX_TURNS_PER_ROUND = 6;
export const CONCURRENCY = 4;
