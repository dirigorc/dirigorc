import { discordOption, type DiscordInteraction } from "./discord-reply";
import type { EmailAttachment } from "./dispatch";

export const DISCORD_IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);
export const MAX_DISCORD_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const DISCORD_ATTACHMENT_OPTION_NAMES = ["image1", "image2", "image3", "image4", "image5"] as const;

export interface DiscordAttachmentSummary {
	attachments: EmailAttachment[];
	skipped: string[];
	requested: number;
}

export interface DiscordResolvedAttachment {
	id?: string;
	filename?: string;
	content_type?: string;
	size?: number;
	url?: string;
}

export function discordAttachmentFromOption(interaction: DiscordInteraction, optionName: string): DiscordResolvedAttachment | null {
	const rawId = discordOption(interaction, optionName);
	if (rawId === "" || rawId === false) return null;
	const id = String(rawId);
	return interaction.data?.resolved?.attachments?.[id] || null;
}

export function attachmentContentType(item: DiscordResolvedAttachment): string {
	return String(item.content_type || "").split(";")[0].trim().toLowerCase();
}

export function discordRequestedAttachmentCount(interaction: DiscordInteraction): number {
	return DISCORD_ATTACHMENT_OPTION_NAMES
		.map((optionName) => discordAttachmentFromOption(interaction, optionName))
		.filter(Boolean).length;
}

export async function discordAttachments(interaction: DiscordInteraction): Promise<DiscordAttachmentSummary> {
	const selected = DISCORD_ATTACHMENT_OPTION_NAMES
		.map((optionName) => discordAttachmentFromOption(interaction, optionName))
		.filter((item): item is DiscordResolvedAttachment => Boolean(item));

	const attachments: EmailAttachment[] = [];
	const skipped: string[] = [];
	for (const item of selected) {
		const contentType = attachmentContentType(item);
		const filename = item.filename || "attachment";
		const size = Number(item.size || 0);
		const url = item.url || "";
		if (!url) {
			skipped.push(`${filename}: missing Discord attachment URL`);
			continue;
		}
		if (!DISCORD_IMAGE_CONTENT_TYPES.has(contentType)) {
			skipped.push(`${filename}: unsupported file type`);
			continue;
		}
		if (size <= 0 || size > MAX_DISCORD_ATTACHMENT_BYTES) {
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
		if (bytes.length === 0 || bytes.length > MAX_DISCORD_ATTACHMENT_BYTES) {
			skipped.push(`${filename}: empty or over the 8 MB per-image limit`);
			continue;
		}

		attachments.push({
			filename,
			content_type: contentType,
			data: bytesToBase64(bytes),
		});
	}

	return { attachments, skipped, requested: selected.length };
}

export function attachmentAcceptanceNote(summary: DiscordAttachmentSummary): string {
	if (summary.requested <= 0) return "";
	const details = [`${summary.attachments.length}/${summary.requested} image attachment(s) accepted.`];
	if (summary.skipped.length > 0) {
		details.push(`Skipped: ${summary.skipped.slice(0, 3).join("; ")}.`);
		if (summary.skipped.length > 3) {
			details.push(`Plus ${summary.skipped.length - 3} more skipped image(s).`);
		}
	}
	return details.join(" ");
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
}
