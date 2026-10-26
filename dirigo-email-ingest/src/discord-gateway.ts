import { DurableObject } from "cloudflare:workers";

import {
	acknowledgeRecap,
	handleRecapReaction,
	pendingReactionValue,
	planReactionScan,
	reactionClaimable,
	reactionStorageKey,
	releaseRecapAck,
	type ReactionScanMessage,
} from "./discord-reaction";
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
	private heardHello = false;
	private socketOpenedAt = 0;
	private resumeUrl = "";
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
			this.resumeUrl = (await ctx.storage.get<string>("resumeUrl")) || "";
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/ensure") return new Response("Not found\n", { status: 404 });
		if (!this.env.DISCORD_BOT_TOKEN) return Response.json({ ok: false, reason: "missing bot token" });
		try {
			await this.scanRecentReactions();
		} catch (error) {
			console.error(JSON.stringify({
				message: "Discord reaction scan failed",
				error: error instanceof Error ? error.message : String(error),
			}));
		}
		this.ctx.waitUntil(this.openGateway());
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
			if (!this.heardHello) {
				if (this.socketOpenedAt > 0 && Date.now() - this.socketOpenedAt > 15_000) {
					this.socket?.close(4000, "hello timeout");
					this.socket = null;
				}
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
		let response: Response;
		try {
			response = await fetch(this.gatewayUrl(), { headers: { Upgrade: "websocket" } });
		} catch (error) {
			console.error(JSON.stringify({
				message: "Discord gateway connection failed",
				error: error instanceof Error ? error.message : String(error),
			}));
			return;
		}
		const socket = response.webSocket;
		if (!socket) {
			const detail = (await response.text()).slice(0, 300);
			console.error(JSON.stringify({
				message: "Discord gateway did not upgrade",
				status: response.status,
				detail,
			}));
			return;
		}
		socket.accept();
		this.socket = socket;
		this.heardHello = false;
		this.socketOpenedAt = Date.now();
		socket.addEventListener("message", (event) => {
			const task = this.onMessage(socket, event.data);
			try {
				this.ctx.waitUntil(task);
			} catch (error) {
				console.error(JSON.stringify({
					message: "Discord gateway message was not kept alive",
					error: error instanceof Error ? error.message : String(error),
				}));
			}
		});
		socket.addEventListener("close", (event) => {
			if (this.socket === socket) this.socket = null;
			this.heardHello = false;
			const task = this.onClose(event.code);
			try {
				this.ctx.waitUntil(task);
			} catch (error) {
				console.error(JSON.stringify({
					message: "Discord gateway close was not kept alive",
					error: error instanceof Error ? error.message : String(error),
				}));
			}
		});
		socket.addEventListener("error", (event) => {
			const detail = gatewayErrorDetail(event);
			console.error(JSON.stringify({ message: "Discord gateway error", detail }));
			if (this.socket === socket) this.socket = null;
			this.heardHello = false;
		});
	}

	private gatewayUrl(): string {
		const base = this.sessionId && this.resumeUrl ? this.resumeUrl : "wss://gateway.discord.gg";
		const url = new URL(base.replace(/^wss:/, "https:"));
		url.searchParams.set("v", "10");
		url.searchParams.set("encoding", "json");
		return url.toString();
	}

	private async onMessage(socket: WebSocket, data: unknown): Promise<void> {
		const text = await gatewayText(data);
		if (!text) return;
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
			this.heardHello = true;
			this.acked = true;
			const firstBeat = Math.max(1_000, Math.floor(interval * Math.random()));
			await this.ctx.storage.setAlarm(Date.now() + firstBeat);
			if (this.sessionId) this.sendResume();
			else this.sendIdentify();
			return;
		}
		if (packet.op === 1) {
			this.send({ op: 1, d: this.sequence });
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
				this.resumeUrl = "";
				await this.ctx.storage.delete("sessionId");
				await this.ctx.storage.delete("resumeUrl");
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
			this.resumeUrl = ready && typeof ready.resume_gateway_url === "string" ? ready.resume_gateway_url : "";
			this.botUserId = user && typeof user.id === "string" ? user.id : "";
			this.pausedUntil = 0;
			await this.ctx.storage.put("sessionId", this.sessionId);
			await this.ctx.storage.put("resumeUrl", this.resumeUrl);
			await this.ctx.storage.put("botUserId", this.botUserId);
			await this.ctx.storage.delete("pausedUntil");
			console.log(JSON.stringify({ message: "Discord gateway ready" }));
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
		const key = reactionStorageKey(channelId, messageId, emojiName);
		if (!(await this.claimReaction(key))) return;
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
			await this.ctx.storage.put(key, outcome === "started" ? "done" : "asked");
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
		await this.ctx.storage.delete(reactionStorageKey(channelId, messageId, emojiName));
		await releaseRecapAck(this.env, channelId, messageId);
	}

	private async onClose(code: number): Promise<void> {
		console.log(JSON.stringify({ message: "Discord gateway closed", code }));
		if (code === 4007 || code === 4009) {
			this.sessionId = "";
			this.resumeUrl = "";
			await this.ctx.storage.delete("sessionId");
			await this.ctx.storage.delete("resumeUrl");
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

	private async claimReaction(key: string): Promise<boolean> {
		const now = Date.now();
		let claimed = false;
		await this.ctx.storage.transaction(async (txn) => {
			claimed = false;
			const current = await txn.get<string>(key);
			if (!reactionClaimable(typeof current === "string" ? current : undefined, now)) return;
			await txn.put(key, pendingReactionValue(now));
			claimed = true;
		});
		return claimed;
	}

	private async scanRecentReactions(): Promise<void> {
		if (!this.env.DISCORD_BOT_TOKEN) return;
		const now = Date.now();
		const lastScanAt = await this.ctx.storage.get<number>("lastScanAt");
		if (typeof lastScanAt === "number" && now - lastScanAt < 60_000) return;
		await this.ctx.storage.put("lastScanAt", now);

		const guilds = await this.discordGet<{ id?: string }[]>("/users/@me/guilds");
		if (!guilds) return;
		const guildIds = guilds
			.map((guild) => guild.id)
			.filter((id): id is string => Boolean(id) && (!this.env.DISCORD_GUILD_ID || id === this.env.DISCORD_GUILD_ID));
		const targets: { channelId: string; guildId: string }[] = [];
		for (const guildId of guildIds) {
			const channels = await this.discordGet<{ id?: string; type?: number }[]>(`/guilds/${guildId}/channels`);
			for (const channel of channels || []) {
				if (channel.id && (channel.type === 0 || channel.type === 5)) targets.push({ channelId: channel.id, guildId });
			}
			const threads = await this.discordGet<{ threads?: { id?: string }[] }>(`/guilds/${guildId}/threads/active`);
			for (const thread of threads?.threads || []) {
				if (thread.id) targets.push({ channelId: thread.id, guildId });
			}
		}
		targets.sort((left, right) => left.channelId.localeCompare(right.channelId));
		const storedIndex = await this.ctx.storage.get<number>("scanIndex");
		const index = typeof storedIndex === "number" && storedIndex < targets.length ? storedIndex : 0;
		const batch = targets.slice(index, index + 25);
		await this.ctx.storage.put("scanIndex", index + batch.length >= targets.length ? 0 : index + batch.length);

		const messages: ReactionScanMessage[] = [];
		for (const target of batch) {
			const page = await this.discordGet<{ id?: string; reactions?: ReactionScanMessage["reactions"] }[]>(
				`/channels/${target.channelId}/messages?limit=50`,
			);
			for (const message of page || []) {
				if (!message.id) continue;
				messages.push({
					channelId: target.channelId,
					messageId: message.id,
					guildId: target.guildId,
					reactions: message.reactions,
				});
			}
		}

		const listed = await this.ctx.storage.list({ prefix: "reaction:" });
		const states = new Map<string, string>();
		for (const [key, value] of listed) {
			if (typeof value === "string") states.set(key, value);
		}
		const plan = planReactionScan(messages, states, this.env.DISCORD_RECAP_EMOJI, now);
		for (const key of plan.clear) await this.ctx.storage.delete(key);
		for (const item of plan.release) await releaseRecapAck(this.env, item.channelId, item.messageId);
		for (const item of plan.acknowledge) await acknowledgeRecap(this.env, item.channelId, item.messageId);

		let started = 0;
		for (const item of plan.start) {
			if (!(await this.claimReaction(item.key))) continue;
			const users = await this.discordGet<{ id?: string; username?: string; global_name?: string | null; bot?: boolean }[]>(
				`/channels/${item.channelId}/messages/${item.messageId}/reactions/${encodeURIComponent(item.emojiPath)}?limit=25`,
			);
			const reactor = (users || []).find((user) => user.id && !user.bot);
			if (!users || !reactor?.id) {
				await this.ctx.storage.delete(item.key);
				continue;
			}
			try {
				const outcome = await handleRecapReaction(this.env, {
					channelId: item.channelId,
					messageId: item.messageId,
					guildId: item.guildId,
					emojiName: item.emojiName,
					reactor: reporterFromUser(reactor),
				});
				await this.ctx.storage.put(item.key, outcome === "started" ? "done" : "asked");
				if (outcome === "started") started += 1;
			} catch (error) {
				await this.ctx.storage.delete(item.key);
				console.error(JSON.stringify({
					message: "Discord reaction recap failed",
					error: error instanceof Error ? error.message : String(error),
				}));
			}
		}
		console.log(JSON.stringify({
			message: "Discord reaction scan",
			channels: batch.length,
			flagged: plan.start.length,
			started,
		}));
	}

	private async discordGet<T>(path: string): Promise<T | null> {
		const token = this.env.DISCORD_BOT_TOKEN;
		if (!token) return null;
		const response = await fetch(`https://discord.com/api/v10${path}`, {
			headers: { Authorization: `Bot ${token}` },
		});
		if (response.status === 429 || response.status >= 500) {
			throw new Error(`Discord reaction scan paused: ${response.status} ${path}`);
		}
		if (!response.ok) {
			console.error(JSON.stringify({ message: "Discord reaction scan skipped", path, status: response.status }));
			return null;
		}
		return response.json() as Promise<T>;
	}
}

export async function ensureDiscordGateway(env: WorkerEnv): Promise<void> {
	if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GATEWAY) {
		console.error(JSON.stringify({
			message: "Discord recap check skipped",
			hasToken: Boolean(env.DISCORD_BOT_TOKEN),
			hasBinding: Boolean(env.DISCORD_GATEWAY),
		}));
		return;
	}
	const stub = env.DISCORD_GATEWAY.getByName("diri");
	await stub.fetch("https://discord-gateway.internal/ensure");
}

async function gatewayText(data: unknown): Promise<string> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
	if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
	if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
	return "";
}

function gatewayErrorDetail(event: Event): string {
	if ("message" in event && typeof event.message === "string") return event.message;
	return "";
}

function record(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}
