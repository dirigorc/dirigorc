export const DISCORD_INTERACTION_PING = 1;
export const DISCORD_INTERACTION_APPLICATION_COMMAND = 2;
export const DISCORD_INTERACTION_MESSAGE_COMPONENT = 3;
export const DISCORD_INTERACTION_MODAL_SUBMIT = 5;
export const DISCORD_RESPONSE_PONG = 1;
export const DISCORD_RESPONSE_CHANNEL_MESSAGE = 4;
export const DISCORD_RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;
export const DISCORD_RESPONSE_DEFERRED_UPDATE_MESSAGE = 6;
export const DISCORD_RESPONSE_MODAL = 9;
export const DISCORD_MESSAGE_EPHEMERAL = 1 << 6;

export interface DiscordUser {
	id?: string;
	username?: string;
	global_name?: string;
}

export interface DiscordOption {
	name?: string;
	value?: string | number | boolean;
}

export interface DiscordInteraction {
	type?: number;
	application_id?: string;
	token?: string;
	channel_id?: string;
	data?: {
		name?: string;
		custom_id?: string;
		options?: DiscordOption[];
		components?: Array<{
			type?: number;
			components?: Array<{
				type?: number;
				custom_id?: string;
				value?: string;
			}>;
		}>;
		resolved?: {
			attachments?: Record<string, {
				id?: string;
				filename?: string;
				content_type?: string;
				size?: number;
				url?: string;
			}>;
		};
	};
	member?: {
		user?: DiscordUser;
	};
	user?: DiscordUser;
	message?: {
		id?: string;
		embeds?: unknown[];
		components?: unknown[];
	};
}

export function discordUser(interaction: DiscordInteraction): DiscordUser {
	return interaction.member?.user || interaction.user || {};
}

export function discordSubmittedBy(interaction: DiscordInteraction): string {
	const user = discordUser(interaction);
	const name = user.global_name || user.username || "Unknown Discord user";
	return user.id ? `${name} (${user.id})` : name;
}

export function discordOption(interaction: DiscordInteraction, name: string): string | number | boolean | "" {
	const options = interaction.data?.options || [];
	return options.find((option) => option.name === name)?.value || "";
}

export function discordModalField(interaction: DiscordInteraction, customId: string): string {
	const rows = interaction.data?.components || [];
	for (const row of rows) {
		for (const component of row.components || []) {
			if (component.custom_id === customId) return String(component.value || "");
		}
	}
	return "";
}

export function discordModalInput(interaction: DiscordInteraction, customId: string): string {
	return discordModalField(interaction, customId).trim();
}

export function discordAck(content: string): Response {
	return new Response(
		JSON.stringify({
			type: DISCORD_RESPONSE_CHANNEL_MESSAGE,
			data: {
				content,
				flags: DISCORD_MESSAGE_EPHEMERAL,
			},
		}),
		{ headers: { "content-type": "application/json" } },
	);
}

export function discordDeferredAck(): Response {
	return new Response(
		JSON.stringify({
			type: DISCORD_RESPONSE_DEFERRED_CHANNEL_MESSAGE,
			data: {
				flags: DISCORD_MESSAGE_EPHEMERAL,
			},
		}),
		{ headers: { "content-type": "application/json" } },
	);
}

export async function discordFollowup(interaction: DiscordInteraction, content: string, components?: unknown[]): Promise<void> {
	const applicationId = interaction.application_id;
	const token = interaction.token;
	if (!applicationId || !token) return;
	const response = await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${token}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			content,
			flags: DISCORD_MESSAGE_EPHEMERAL,
			...(components ? { components } : {}),
		}),
	});
	if (!response.ok) {
		throw new Error(`Discord follow-up failed: ${response.status} ${await response.text()}`);
	}
}
