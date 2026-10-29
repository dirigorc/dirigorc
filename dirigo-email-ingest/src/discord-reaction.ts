import { dispatchToGitHub, type EmailAttachment, type EmailPayload, type WorkerEnv } from "./dispatch";
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, NEARBY_LIMIT, draftRecapFromMessages, type ImageRef } from "./recap-window";
import {
	DATEISH_PATTERN,
	calendarEmojiName,
	emojiMatches,
	formatReporter,
	incompleteMemberNameReason,
	recapEmojiName,
	reporterFromUser,
	type Reporter,
} from "./self-report";

export interface RecapReaction {
	channelId: string;
	messageId: string;
	guildId: string;
	emojiName: string;
	reactor: Reporter;
}

export interface ReactionScanMessage {
	channelId: string;
	messageId: string;
	guildId?: string;
	reactions?: { me?: boolean; emoji?: { id?: string | null; name?: string | null } }[];
}

export interface PlannedReaction {
	channelId: string;
	messageId: string;
	guildId: string;
	emojiName: string;
	emojiPath: string;
	key: string;
}

const PENDING_PREFIX = "pending:";
const STALE_PENDING_MS = 2 * 60 * 1000;

export function reactionStorageKey(channelId: string, messageId: string, emojiName: string): string {
	return `reaction:${channelId}:${messageId}:${emojiName}`;
}

export function pendingReactionValue(now: number): string {
	return `${PENDING_PREFIX}${now}`;
}

export function recapAckEmoji(configured: string | undefined): string {
	return recapEmojiName(configured) === "✅" ? "👀" : "✅";
}

export function calendarAckEmoji(configured: string | undefined): string {
	return calendarEmojiName(configured) === "📌" ? "👀" : "📌";
}

export function reactionClaimable(value: string | undefined, now: number): boolean {
	if (!value) return true;
	if (value === "done" || value === "asked") return false;
	if (value.startsWith(PENDING_PREFIX)) {
		const startedAt = Number(value.slice(PENDING_PREFIX.length));
		return Number.isFinite(startedAt) && now - startedAt > STALE_PENDING_MS;
	}
	return true;
}

export function planReactionScan(
	messages: ReactionScanMessage[],
	states: ReadonlyMap<string, string>,
	configured: string | undefined,
	now: number,
	ackName?: string,
): { start: PlannedReaction[]; clear: string[]; acknowledge: PlannedAck[]; release: PlannedAck[] } {
	const start: PlannedReaction[] = [];
	const clear: string[] = [];
	const acknowledge: PlannedAck[] = [];
	const release: PlannedAck[] = [];
	const emojiName = recapEmojiName(configured);
	const ackEmoji = ackName || recapAckEmoji(configured);
	for (const message of messages) {
		const key = reactionStorageKey(message.channelId, message.messageId, emojiName);
		const reaction = (message.reactions || []).find((item) => emojiMatches(item.emoji?.name || "", configured));
		const acknowledged = (message.reactions || []).some((item) => item.me === true && (item.emoji?.name || "") === ackEmoji);
		if (!reaction) {
			if (states.has(key)) clear.push(key);
			if (acknowledged) release.push({ channelId: message.channelId, messageId: message.messageId });
			continue;
		}
		if (acknowledged) continue;
		if (states.get(key) === "done") {
			acknowledge.push({ channelId: message.channelId, messageId: message.messageId });
			continue;
		}
		if (!reactionClaimable(states.get(key), now)) continue;
		const emojiId = reaction.emoji?.id;
		start.push({
			channelId: message.channelId,
			messageId: message.messageId,
			guildId: message.guildId || "",
			emojiName,
			emojiPath: emojiId ? `${reaction.emoji?.name}:${emojiId}` : emojiName,
			key,
		});
	}
	return { start, clear, acknowledge, release };
}

export interface PlannedAck {
	channelId: string;
	messageId: string;
}

export async function handleRecapReaction(env: WorkerEnv, reaction: RecapReaction): Promise<"started" | "skipped" | "needs-detail"> {
	if (!emojiMatches(reaction.emojiName, env.DISCORD_RECAP_EMOJI)) return "skipped";
	if (env.DISCORD_GUILD_ID && reaction.guildId && reaction.guildId !== env.DISCORD_GUILD_ID) return "skipped";
	if (!snowflake(reaction.channelId) || !snowflake(reaction.messageId)) return "skipped";
	if (!env.DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN is not set.");

	const anchorResponse = await fetch(`https://discord.com/api/v10/channels/${reaction.channelId}/messages/${reaction.messageId}`, {
		headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
	});
	if (!anchorResponse.ok) {
		await channelReply(env, reaction, "I couldn't read that message. Diri needs permission to view the channel and read its history.");
		return "needs-detail";
	}

	let nearbyPayload: unknown = undefined;
	try {
		const nearbyResponse = await fetch(
			`https://discord.com/api/v10/channels/${reaction.channelId}/messages?around=${reaction.messageId}&limit=${NEARBY_LIMIT}`,
			{ headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
		);
		nearbyPayload = await readNearbyPayload(nearbyResponse);
	} catch {
		nearbyPayload = undefined;
	}

	const draft = draftRecapFromMessages(await anchorResponse.json(), nearbyPayload, {
		channelId: reaction.channelId,
		messageId: reaction.messageId,
		guildId: reaction.guildId,
		reactor: reaction.reactor,
		nowMs: Date.now(),
	});
	switch (draft.status) {
		case "skipped":
		case "needs-detail":
			await channelReply(env, reaction, draft.reply);
			return draft.status;
		case "ready":
			break;
		default: {
			const unreachable: never = draft;
			throw new Error(`Unexpected recap draft: ${JSON.stringify(unreachable)}`);
		}
	}

	const downloaded = await downloadImages(draft.fields.images);
	const inference = draft.fields.inference
		? { ...draft.fields.inference, notes: [...draft.fields.inference.notes] }
		: null;
	if (inference && formatReporter(reaction.reactor) !== draft.fields.authoredBy) {
		inference.notes.push(`${formatReporter(reaction.reactor)} started this recap from ${draft.fields.authoredBy}'s message.`);
	}
	const email: EmailPayload = {
		source: "discord",
		command: "recap",
		editorial_mode: draft.fields.editorialMode,
		submitted_by: draft.fields.submittedBy,
		from: draft.fields.submittedBy,
		subject: "Discord /recap",
		text: draft.fields.text,
		body: draft.fields.text,
		raw: "",
		attachments: downloaded.attachments,
		links: [...draft.fields.links],
		trigger: "reaction",
		authored_by: draft.fields.authoredBy,
		...(inference ? { inference } : {}),
	};
	await dispatchToGitHub(env, email);
	await acknowledgeRecap(env, reaction.channelId, reaction.messageId);
	return "started";
}

export async function handleCalendarReaction(env: WorkerEnv, reaction: RecapReaction): Promise<"started" | "skipped" | "needs-detail"> {
	const expected = calendarEmojiName(env.DISCORD_CALENDAR_EMOJI);
	if (expected.toLowerCase() === recapEmojiName(env.DISCORD_RECAP_EMOJI).toLowerCase()) return "skipped";
	if (reaction.emojiName !== expected && reaction.emojiName.toLowerCase() !== expected.toLowerCase()) return "skipped";
	if (env.DISCORD_GUILD_ID && reaction.guildId && reaction.guildId !== env.DISCORD_GUILD_ID) return "skipped";
	if (!snowflake(reaction.channelId) || !snowflake(reaction.messageId)) return "skipped";
	if (!env.DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN is not set.");

	const anchorResponse = await fetch(`https://discord.com/api/v10/channels/${reaction.channelId}/messages/${reaction.messageId}`, {
		headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
	});
	if (!anchorResponse.ok) {
		await channelReply(env, reaction, "I couldn't read that message. Diri needs permission to view the channel and read its history.");
		return "needs-detail";
	}
	const message = calendarMessage(await anchorResponse.json());
	if (!message) {
		await channelReply(env, reaction, "I couldn't read that message. Diri needs permission to view the channel and read its history.");
		return "needs-detail";
	}
	if (message.bot) {
		await channelReply(env, reaction, "I start calendar events from a member's message.");
		return "skipped";
	}
	const reason = eventClarification(message.text);
	if (reason) {
		await channelReply(env, reaction, reason);
		return "needs-detail";
	}
	const downloaded = await downloadImages(message.images);
	const email: EmailPayload = {
		source: "discord",
		command: "event",
		editorial_mode: "agentic",
		submitted_by: formatReporter(reaction.reactor),
		from: formatReporter(reaction.reactor),
		subject: "Discord /event",
		text: message.text,
		body: message.text,
		raw: "",
		attachments: downloaded.attachments,
		links: linkUrls(message.text),
		trigger: "reaction",
		authored_by: message.authoredBy,
	};
	await dispatchToGitHub(env, email);
	await acknowledgeCalendar(env, reaction.channelId, reaction.messageId);
	return "started";
}

async function readNearbyPayload(response: Response): Promise<unknown> {
	if (response.status !== 200) return undefined;
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

function snowflake(value: string): boolean {
	return /^\d{5,22}$/.test(value);
}

async function downloadImages(items: readonly ImageRef[]): Promise<{ attachments: EmailAttachment[]; skipped: string[]; requested: number }> {
	const selected = items.slice(0, MAX_IMAGES);
	const attachments: EmailAttachment[] = [];
	const skipped: string[] = [];
	for (const item of selected) {
		const filename = item.filename || "attachment";
		const contentType = String(item.content_type || "").split(";")[0].trim().toLowerCase();
		const size = Number(item.size || 0);
		const url = item.url || "";
		if (!url) {
			skipped.push(`${filename}: missing Discord attachment URL`);
			continue;
		}
		if (!IMAGE_CONTENT_TYPES.has(contentType)) {
			skipped.push(`${filename}: unsupported file type`);
			continue;
		}
		if (size <= 0 || size > MAX_IMAGE_BYTES) {
			skipped.push(`${filename}: over the 8 MB per-image limit`);
			continue;
		}
		let response: Response;
		try {
			response = await fetch(url);
		} catch {
			skipped.push(`${filename}: could not fetch from Discord`);
			continue;
		}
		if (!response.ok) {
			skipped.push(`${filename}: Discord returned ${response.status}`);
			continue;
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
			skipped.push(`${filename}: empty or over the 8 MB per-image limit`);
			continue;
		}
		attachments.push({ filename, content_type: contentType, data: bytesToBase64(bytes) });
	}
	if (items.length > MAX_IMAGES) skipped.push(`Only the first ${MAX_IMAGES} images were kept.`);
	return { attachments, skipped, requested: selected.length };
}

export async function acknowledgeRecap(env: WorkerEnv, channelId: string, messageId: string): Promise<void> {
	await reactAsBot(env, channelId, messageId, "PUT", recapAckEmoji(env.DISCORD_RECAP_EMOJI));
}

export async function releaseRecapAck(env: WorkerEnv, channelId: string, messageId: string): Promise<void> {
	await reactAsBot(env, channelId, messageId, "DELETE", recapAckEmoji(env.DISCORD_RECAP_EMOJI));
}

export async function acknowledgeCalendar(env: WorkerEnv, channelId: string, messageId: string): Promise<void> {
	await reactAsBot(env, channelId, messageId, "PUT", calendarAckEmoji(env.DISCORD_CALENDAR_EMOJI));
}

export async function releaseCalendarAck(env: WorkerEnv, channelId: string, messageId: string): Promise<void> {
	await reactAsBot(env, channelId, messageId, "DELETE", calendarAckEmoji(env.DISCORD_CALENDAR_EMOJI));
}

async function reactAsBot(
	env: WorkerEnv,
	channelId: string,
	messageId: string,
	method: "PUT" | "DELETE",
	emojiName: string,
): Promise<void> {
	if (!env.DISCORD_BOT_TOKEN || !snowflake(channelId) || !snowflake(messageId)) return;
	const emoji = encodeURIComponent(emojiName);
	const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${emoji}/@me`, {
		method,
		headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
	});
	if (!response.ok) {
		console.error(JSON.stringify({
			message: "Discord acknowledgement failed",
			method,
			status: response.status,
			detail: await response.text(),
		}));
	}
}

function eventClarification(text: string): string {
	const trimmed = text.trim();
	const words = trimmed.split(/\s+/).filter(Boolean).length;
	if (!trimmed) return "Please add the event name, date, time, location, and any useful links.";
	if (!DATEISH_PATTERN.test(trimmed)) return "Please add the event date before I create a calendar PR.";
	if (words < 4) return "Please add a little more context, like the event name, location, and time.";
	return incompleteMemberNameReason(trimmed);
}

function calendarMessage(payload: unknown): { bot: boolean; authoredBy: string; text: string; images: ImageRef[] } | null {
	if (!isRecord(payload)) return null;
	const author = isRecord(payload.author) ? payload.author : null;
	if (!author) return null;
	const reporter = reporterFromUser({
		id: typeof author.id === "string" ? author.id : undefined,
		username: typeof author.username === "string" ? author.username : undefined,
		global_name: typeof author.global_name === "string" || author.global_name === null ? author.global_name : undefined,
		bot: author.bot === true,
	});
	return {
		bot: reporter.bot === true,
		authoredBy: formatReporter(reporter),
		text: typeof payload.content === "string" ? payload.content.trim() : "",
		images: imageRefs(payload.attachments),
	};
}

function imageRefs(attachments: unknown): ImageRef[] {
	if (!Array.isArray(attachments)) return [];
	const refs: ImageRef[] = [];
	for (const item of attachments) {
		if (!isRecord(item)) continue;
		const filename = typeof item.filename === "string" && item.filename ? item.filename : "attachment";
		const contentType = String(item.content_type || "").split(";")[0].trim().toLowerCase();
		const size = Number(item.size || 0);
		const url = typeof item.url === "string" ? item.url : "";
		if (!url || !IMAGE_CONTENT_TYPES.has(contentType) || size <= 0 || size > MAX_IMAGE_BYTES) continue;
		refs.push({ filename, content_type: contentType, size, url });
	}
	return refs;
}

function linkUrls(text: string): string[] {
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const match of text.match(/https?:\/\/[^\s<>()"']+/gi) || []) {
		const cleaned = match.replace(/[),.;!?]+$/, "");
		if (!cleaned || seen.has(cleaned)) continue;
		seen.add(cleaned);
		unique.push(cleaned);
	}
	return unique;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function channelReply(env: WorkerEnv, reaction: RecapReaction, content: string): Promise<void> {
	const response = await fetch(`https://discord.com/api/v10/channels/${reaction.channelId}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			content: content.slice(0, 2000),
			message_reference: {
				message_id: reaction.messageId,
				channel_id: reaction.channelId,
				fail_if_not_exists: false,
			},
			allowed_mentions: { parse: [] },
		}),
	});
	if (!response.ok) {
		console.error(JSON.stringify({
			message: "Discord reaction reply failed",
			status: response.status,
			detail: await response.text(),
		}));
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
}
