import { dispatchToGitHub, type EmailAttachment, type EmailPayload, type WorkerEnv } from "./dispatch";
import {
	emojiMatches,
	formatReporter,
	prepareRecap,
	recapClarificationReason,
	recapStartedMessage,
	reporterFromUser,
	type Reporter,
} from "./self-report";

const IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 5;

export interface RecapReaction {
	channelId: string;
	messageId: string;
	guildId: string;
	emojiName: string;
	reactor: Reporter;
}

interface DiscordMessage {
	content: string;
	timestamp: string;
	author: Reporter;
	attachments: DiscordMessageAttachment[];
}

interface DiscordMessageAttachment {
	filename?: string;
	content_type?: string;
	size?: number;
	url?: string;
}

export async function handleRecapReaction(env: WorkerEnv, reaction: RecapReaction): Promise<"started" | "skipped" | "needs-detail"> {
	if (!emojiMatches(reaction.emojiName, env.DISCORD_RECAP_EMOJI)) return "skipped";
	if (env.DISCORD_GUILD_ID && reaction.guildId && reaction.guildId !== env.DISCORD_GUILD_ID) return "skipped";
	if (!snowflake(reaction.channelId) || !snowflake(reaction.messageId)) return "skipped";
	if (!env.DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN is not set.");

	const message = await fetchMessage(env, reaction.channelId, reaction.messageId);
	if (!message) {
		await channelReply(env, reaction, "I couldn't read that message. Diri needs permission to view the channel and read its history.");
		return "needs-detail";
	}
	if (message.author.bot) {
		await channelReply(env, reaction, "I start recaps from a member's message.");
		return "skipped";
	}
	const body = message.content.trim();
	if (!body) {
		await channelReply(env, reaction, "That message has no text I can use. If it already has text, enable the Message Content intent for Diri and react again.");
		return "needs-detail";
	}

	const reportedAt = Date.parse(message.timestamp);
	const prepared = prepareRecap(body, message.author, Number.isNaN(reportedAt) ? Date.now() : reportedAt, "verbatim");
	const reason = recapClarificationReason(body, message.author, message.attachments.length);
	if (reason) {
		await channelReply(env, reaction, reason);
		return "needs-detail";
	}

	const downloaded = await downloadImages(message.attachments);
	const links = uniqueUrls([body, messageLink(reaction)]);
	if (prepared.inference && formatReporter(reaction.reactor) !== formatReporter(message.author)) {
		prepared.inference.notes.push(`${formatReporter(reaction.reactor)} started this recap from ${formatReporter(message.author)}'s message.`);
	}
	const email: EmailPayload = {
		source: "discord",
		command: "recap",
		editorial_mode: prepared.editorialMode,
		submitted_by: formatReporter(reaction.reactor),
		from: formatReporter(reaction.reactor),
		subject: "Discord /recap",
		text: body,
		body,
		raw: "",
		attachments: downloaded.attachments,
		links,
		trigger: "reaction",
		authored_by: formatReporter(message.author),
		...(prepared.inference ? { inference: prepared.inference } : {}),
	};
	await dispatchToGitHub(env, email);
	const details = imageDetails(downloaded);
	await channelReply(env, reaction, `${recapStartedMessage(prepared.editorialMode)}${details ? `\n\n${details}` : ""}`);
	return "started";
}

function snowflake(value: string): boolean {
	return /^\d{5,22}$/.test(value);
}

function messageLink(reaction: RecapReaction): string {
	if (!snowflake(reaction.guildId)) return "";
	return `https://discord.com/channels/${reaction.guildId}/${reaction.channelId}/${reaction.messageId}`;
}

async function fetchMessage(env: WorkerEnv, channelId: string, messageId: string): Promise<DiscordMessage | null> {
	const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
		headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
	});
	if (!response.ok) return null;
	const payload = (await response.json()) as {
		content?: string;
		timestamp?: string;
		author?: { id?: string; username?: string; global_name?: string | null; bot?: boolean };
		attachments?: DiscordMessageAttachment[];
	};
	return {
		content: String(payload.content || ""),
		timestamp: String(payload.timestamp || ""),
		author: reporterFromUser(payload.author || {}),
		attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
	};
}

async function downloadImages(items: DiscordMessageAttachment[]): Promise<{ attachments: EmailAttachment[]; skipped: string[]; requested: number }> {
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

function imageDetails(summary: { attachments: EmailAttachment[]; skipped: string[]; requested: number }): string {
	const details: string[] = [];
	if (summary.requested > 0) details.push(`${summary.attachments.length}/${summary.requested} image attachment(s) accepted.`);
	if (summary.skipped.length > 0) details.push(`Skipped: ${summary.skipped.slice(0, 3).join("; ")}.`);
	return details.join("\n");
}

function uniqueUrls(values: string[]): string[] {
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const matches = value.match(/https?:\/\/[^\s<>()"']+/gi) || [];
		for (const match of matches) {
			const cleaned = match.replace(/[),.;!?]+$/, "");
			if (!cleaned || seen.has(cleaned)) continue;
			seen.add(cleaned);
			unique.push(cleaned);
		}
	}
	return unique;
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
