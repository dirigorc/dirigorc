import { DurableObject } from "cloudflare:workers";

import { handleRecapReaction } from "./discord-reaction";
import type { WorkerEnv } from "./dispatch";
import { emojiMatches, reporterFromUser } from "./self-report";

const GUILD_INTENT = 1 << 0;
const REACTION_INTENT = 1 << 10;
const CONNECT_GAP_MS = 10_000;
const RETRY_MS = 5_000;
const PAUSE_MS = 60 * 60 * 1000;

interface GatewayPacket {
	op?: number;
	t?: string | null;
	s?: number | null;
	d?: unknown;
}

export class DiscordGateway extends DurableObject<WorkerEnv> {
	private socket: WebSocket | null = null;
	private sessionId = "";
	private sequence: number | null = null;
	private botUserId = "";
	private heartbeatMs = 41_250;
	private acked = true;
	private pausedUntil = 0;
	private lastConnectAt = 0;

	constructor(ctx: DurableObjectState, env: WorkerEnv) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.sessionId = (await ctx.storage.get<string>("sessionId")) || "";
			const sequence = await ctx.storage.get<number>("sequence");
			this.sequence = typeof sequence === "number" ? sequence : null;
			this.botUserId = (await ctx.storage.get<string>("botUserId")) || "";
			const paused = await ctx.storage.get<number>("pausedUntil");
			this.pausedUntil = typeof paused === "number" ? paused : 0;
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/ensure") return new Response("Not found\n", { status: 404 });
		if (!this.env.DISCORD_BOT_TOKEN) return Response.json({ ok: false, reason: "missing bot token" });
		await this.openGateway();
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
		}
		return Response.json({ ok: true });
	}

	async alarm(): Promise<void> {
		try {
			if (!this.env.DISCORD_BOT_TOKEN) return;
			if (this.pausedUntil > Date.now()) {
				await this.ctx.storage.setAlarm(this.pausedUntil);
				return;
			}
			const state = this.socket?.readyState;
			if (state !== WebSocket.OPEN) {
				if (state !== WebSocket.CONNECTING) await this.openGateway();
				await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
				return;
			}
			if (!this.acked) {
				this.socket?.close(4000, "heartbeat ack missed");
				this.socket = null;
				await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
				return;
			}
			this.acked = false;
			this.send({ op: 1, d: this.sequence });
			await this.ctx.storage.setAlarm(Date.now() + this.heartbeatMs);
		} catch (error) {
			console.error(JSON.stringify({
				message: "Discord gateway alarm failed",
				error: error instanceof Error ? error.message : String(error),
			}));
			await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
		}
	}

	private async openGateway(): Promise<void> {
		if (!this.env.DISCORD_BOT_TOKEN || this.pausedUntil > Date.now()) return;
		const state = this.socket?.readyState;
		if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
		if (Date.now() - this.lastConnectAt < CONNECT_GAP_MS) return;
		this.lastConnectAt = Date.now();
		const socket = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
		this.socket = socket;
		socket.addEventListener("message", (event) => {
			const text = gatewayText(event.data);
			if (!text) return;
			this.ctx.waitUntil(this.onMessage(socket, text));
		});
		socket.addEventListener("close", (event) => {
			if (this.socket === socket) this.socket = null;
			this.ctx.waitUntil(this.onClose(event.code));
		});
		socket.addEventListener("error", () => {
			if (this.socket === socket) this.socket = null;
		});
	}

	private async onMessage(socket: WebSocket, text: string): Promise<void> {
		if (this.socket !== socket) return;
		let packet: GatewayPacket;
		try {
			packet = JSON.parse(text) as GatewayPacket;
		} catch {
			return;
		}
		if (typeof packet.s === "number") {
			this.sequence = packet.s;
			await this.ctx.storage.put("sequence", packet.s);
		}
		if (packet.op === 10) {
			const hello = record(packet.d);
			const interval = hello && typeof hello.heartbeat_interval === "number" ? hello.heartbeat_interval : this.heartbeatMs;
			this.heartbeatMs = interval;
			this.acked = true;
			await this.ctx.storage.setAlarm(Date.now() + interval);
			if (this.sessionId) this.sendResume();
			else this.sendIdentify();
			return;
		}
		if (packet.op === 11) {
			this.acked = true;
			return;
		}
		if (packet.op === 7) {
			socket.close(4000, "reconnect");
			return;
		}
		if (packet.op === 9) {
			if (packet.d !== true) {
				this.sessionId = "";
				await this.ctx.storage.delete("sessionId");
			}
			socket.close(4000, "invalid session");
			return;
		}
		if (packet.op === 0) await this.onDispatch(packet.t || "", packet.d);
	}

	private async onDispatch(name: string, data: unknown): Promise<void> {
		if (name === "READY") {
			const ready = record(data);
			const user = ready ? record(ready.user) : null;
			this.sessionId = ready && typeof ready.session_id === "string" ? ready.session_id : "";
			this.botUserId = user && typeof user.id === "string" ? user.id : "";
			this.pausedUntil = 0;
			await this.ctx.storage.put("sessionId", this.sessionId);
			await this.ctx.storage.put("botUserId", this.botUserId);
			await this.ctx.storage.delete("pausedUntil");
			return;
		}
		if (name === "MESSAGE_REACTION_REMOVE") {
			await this.clearReaction(data);
			return;
		}
		if (name === "MESSAGE_REACTION_ADD") await this.onReaction(data);
	}

	private async onReaction(data: unknown): Promise<void> {
		const payload = record(data);
		if (!payload) return;
		const emoji = record(payload.emoji);
		const emojiName = emoji && typeof emoji.name === "string" ? emoji.name : "";
		if (!emojiMatches(emojiName, this.env.DISCORD_RECAP_EMOJI)) return;
		const userId = typeof payload.user_id === "string" ? payload.user_id : "";
		const channelId = typeof payload.channel_id === "string" ? payload.channel_id : "";
		const messageId = typeof payload.message_id === "string" ? payload.message_id : "";
		const guildId = typeof payload.guild_id === "string" ? payload.guild_id : "";
		if (!userId || userId === this.botUserId || !channelId || !messageId) return;
		const key = reactionKey(channelId, messageId, emojiName);
		if (await this.ctx.storage.get(key)) return;
		await this.ctx.storage.put(key, "pending");
		const member = record(payload.member);
		const user = member ? record(member.user) : null;
		try {
			const outcome = await handleRecapReaction(this.env, {
				channelId,
				messageId,
				guildId,
				emojiName,
				reactor: reporterFromUser({
					id: userId,
					username: user && typeof user.username === "string" ? user.username : undefined,
					global_name: user && typeof user.global_name === "string" ? user.global_name : undefined,
				}),
			});
			if (outcome === "started") await this.ctx.storage.put(key, "done");
			else await this.ctx.storage.delete(key);
		} catch (error) {
			await this.ctx.storage.delete(key);
			console.error(JSON.stringify({
				message: "Discord reaction recap failed",
				error: error instanceof Error ? error.message : String(error),
			}));
		}
	}

	private async clearReaction(data: unknown): Promise<void> {
		const payload = record(data);
		if (!payload) return;
		const emoji = record(payload.emoji);
		const emojiName = emoji && typeof emoji.name === "string" ? emoji.name : "";
		if (!emojiMatches(emojiName, this.env.DISCORD_RECAP_EMOJI)) return;
		const channelId = typeof payload.channel_id === "string" ? payload.channel_id : "";
		const messageId = typeof payload.message_id === "string" ? payload.message_id : "";
		if (!channelId || !messageId) return;
		await this.ctx.storage.delete(reactionKey(channelId, messageId, emojiName));
	}

	private async onClose(code: number): Promise<void> {
		if (code === 4007 || code === 4009) {
			this.sessionId = "";
			await this.ctx.storage.delete("sessionId");
		}
		if (code === 4004 || code === 4013 || code === 4014) {
			this.pausedUntil = Date.now() + PAUSE_MS;
			await this.ctx.storage.put("pausedUntil", this.pausedUntil);
			console.error(JSON.stringify({
				message: "Discord gateway paused",
				code,
			}));
			await this.ctx.storage.setAlarm(this.pausedUntil);
			return;
		}
		await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
	}

	private sendIdentify(): void {
		this.send({
			op: 2,
			d: {
				token: this.env.DISCORD_BOT_TOKEN,
				intents: GUILD_INTENT | REACTION_INTENT,
				properties: { os: "linux", browser: "diri", device: "diri" },
			},
		});
	}

	private sendResume(): void {
		this.send({
			op: 6,
			d: {
				token: this.env.DISCORD_BOT_TOKEN,
				session_id: this.sessionId,
				seq: this.sequence,
			},
		});
	}

	private send(payload: unknown): void {
		if (this.socket?.readyState !== WebSocket.OPEN) return;
		this.socket.send(JSON.stringify(payload));
	}
}

export async function ensureDiscordGateway(env: WorkerEnv): Promise<void> {
	if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GATEWAY) return;
	const stub = env.DISCORD_GATEWAY.getByName("diri");
	await stub.fetch("https://discord-gateway.internal/ensure");
}

function reactionKey(channelId: string, messageId: string, emojiName: string): string {
	return `reaction:${channelId}:${messageId}:${emojiName}`;
}

function gatewayText(data: unknown): string {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
	return "";
}

function record(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}
