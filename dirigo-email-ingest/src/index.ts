/**
 * Cloudflare Worker endpoint for Dirigo race report emails.
 *
 * Supports two entry points:
 * - Email Routing Worker: attach this Worker to an address such as updates@dirigorc.com.
 * - Discord interactions endpoint for the /recap and /event slash commands.
 * - HTTP POST webhook: send JSON or plain text to the Worker URL.
 *
 * Required Worker secrets/vars:
 * - GITHUB_TOKEN: Fine-grained GitHub token with Contents: write on dirigorc/dirigorc.
 * - GITHUB_REPO: "dirigorc/dirigorc"
 * - INGEST_TOKEN: Shared bearer token for HTTP POSTs.
 *
 * Optional vars:
 * - ALLOWED_FROM: Comma-separated sender allowlist for Email Routing.
 * - DISCORD_PUBLIC_KEY: Required only for the Discord interaction endpoint.
 */

const DISPATCH_EVENT_TYPES = {
	recap: "race-report-email",
	event: "calendar-event-email",
} as const;
const DISCORD_INTERACTION_PING = 1;
const DISCORD_INTERACTION_APPLICATION_COMMAND = 2;
const DISCORD_INTERACTION_MODAL_SUBMIT = 5;
const DISCORD_RESPONSE_PONG = 1;
const DISCORD_RESPONSE_CHANNEL_MESSAGE = 4;
const DISCORD_RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;
const DISCORD_RESPONSE_MODAL = 9;
const DISCORD_MESSAGE_EPHEMERAL = 1 << 6;
const DISCORD_IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);
const MAX_DISCORD_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const DISCORD_ATTACHMENT_OPTION_NAMES = ["image1", "image2", "image3", "image4", "image5"];
const DISCORD_RECAP_MODAL_ID = "recap_modal_v1";
const DISCORD_FALLBACK_MESSAGE = "If Discord drops your submission while uploading images, paste the text into the slash command first and send images separately, or use the HTTP test endpoint in the README.";

interface EmailAttachment {
	filename: string;
	content_type: string;
	data: string;
}

interface WorkerEnv {
	GITHUB_TOKEN?: string;
	GITHUB_REPO?: string;
	GITHUB_REF?: string;
	INGEST_TOKEN?: string;
	ALLOWED_FROM?: string;
	DISCORD_PUBLIC_KEY?: string;
}

interface EmailPayload {
	from: string;
	subject: string;
	text: string;
	raw: string;
	source?: string;
	command?: string;
	content_type?: string;
	submitted_by?: string;
	body?: string;
	editorial_mode?: string;
	attachments?: EmailAttachment[];
	links?: string[];
	discord_application_id?: string;
	discord_interaction_token?: string;
}

interface DiscordAttachmentSummary {
	attachments: EmailAttachment[];
	skipped: string[];
	requested: number;
}

interface EmailMessage {
	from?: string | null;
	headers: Headers;
	raw: BodyInit;
	setReject: (reason: string) => void;
}

function allowedSender(sender: string, env: WorkerEnv): boolean {
	if (!env.ALLOWED_FROM) return true;
	const allowed = env.ALLOWED_FROM.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
	return allowed.some((value) => sender.toLowerCase().includes(value));
}

function headerValue(headers: Headers, name: string): string {
	return headers.get(name) || headers.get(name.toLowerCase()) || "";
}

function hexToBytes(hex: string): Uint8Array | null {
	if (!hex || hex.length % 2 !== 0) return null;
	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < hex.length; index += 2) {
		const value = Number.parseInt(hex.slice(index, index + 2), 16);
		if (Number.isNaN(value)) return null;
		bytes[index / 2] = value;
	}
	return bytes;
}

async function verifyDiscordRequest(request: Request, rawBody: Uint8Array, env: WorkerEnv): Promise<boolean> {
	if (!env.DISCORD_PUBLIC_KEY) return false;
	const signature = hexToBytes(request.headers.get("x-signature-ed25519") || "");
	const timestamp = request.headers.get("x-signature-timestamp") || "";
	const publicKey = hexToBytes(env.DISCORD_PUBLIC_KEY);
	if (!signature || !timestamp || !publicKey) return false;

	const timestampBytes = new TextEncoder().encode(timestamp);
	const messageBytes = new Uint8Array(timestampBytes.length + rawBody.length);
	messageBytes.set(timestampBytes, 0);
	messageBytes.set(rawBody, timestampBytes.length);

	let key: CryptoKey;
	try {
		key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
	} catch {
		key = await crypto.subtle.importKey(
			"raw",
			publicKey,
			{ name: "NODE-ED25519", namedCurve: "NODE-ED25519" },
			false,
			["verify"],
		);
	}
	return crypto.subtle.verify(key.algorithm, key, signature, messageBytes);
}

interface DiscordUser {
	id?: string;
	username?: string;
	global_name?: string;
}

interface DiscordOption {
	name?: string;
	value?: string | number | boolean;
}

interface DiscordResolvedAttachment {
	id?: string;
	filename?: string;
	content_type?: string;
	size?: number;
	url?: string;
}

interface DiscordInteraction {
	type?: number;
	application_id?: string;
	token?: string;
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
			attachments?: Record<string, DiscordResolvedAttachment>;
		};
	};
	member?: {
		user?: DiscordUser;
	};
	user?: DiscordUser;
}

function discordUser(interaction: DiscordInteraction): DiscordUser {
	return interaction.member?.user || interaction.user || {};
}

function discordSubmittedBy(interaction: DiscordInteraction): string {
	const user = discordUser(interaction);
	const name = user.global_name || user.username || "Unknown Discord user";
	return user.id ? `${name} (${user.id})` : name;
}

function discordOption(interaction: DiscordInteraction, name: string): string | number | boolean | "" {
	const options = interaction.data?.options || [];
	return options.find((option) => option.name === name)?.value || "";
}

function discordPolishEnabled(interaction: DiscordInteraction): boolean {
	return discordOption(interaction, "polish") === true || discordOption(interaction, "agentic") === true;
}

function discordEditorialMode(interaction: DiscordInteraction): string {
	return discordPolishEnabled(interaction) ? "agentic" : "verbatim";
}

function parsePolish(value: string, fallback = false): boolean {
	const normalized = value.trim().toLowerCase();
	if (!normalized) return fallback;
	return ["1", "true", "yes", "y", "polish", "agentic", "on"].includes(normalized);
}

function normalizeCommand(value: unknown): "recap" | "event" {
	const normalized = String(value || "").trim().toLowerCase();
	if (["event", "calendar", "calendar-event", "calendar_event"].includes(normalized)) return "event";
	return "recap";
}

function extractUrls(text: string): string[] {
	const matches = text.match(/https?:\/\/[^\s<>()"']+/gi) || [];
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const value of matches) {
		const cleaned = value.replace(/[),.;!?]+$/, "");
		if (!cleaned || seen.has(cleaned)) continue;
		seen.add(cleaned);
		unique.push(cleaned);
	}
	return unique;
}

function discordLinks(interaction: DiscordInteraction, body: string): string[] {
	const linksField = String(discordOption(interaction, "links") || "");
	const urls = [...extractUrls(body), ...extractUrls(linksField)];
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const url of urls) {
		if (seen.has(url)) continue;
		seen.add(url);
		unique.push(url);
	}
	return unique;
}

function discordModalInput(interaction: DiscordInteraction, customId: string): string {
	const rows = interaction.data?.components || [];
	for (const row of rows) {
		for (const component of row.components || []) {
			if (component.custom_id === customId) {
				return String(component.value || "").trim();
			}
		}
	}
	return "";
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
}

function discordAttachmentFromOption(interaction: DiscordInteraction, optionName: string): DiscordResolvedAttachment | null {
	const rawId = discordOption(interaction, optionName);
	if (rawId === "" || rawId === false) return null;
	const id = String(rawId);
	return interaction.data?.resolved?.attachments?.[id] || null;
}

function discordRequestedAttachmentCount(interaction: DiscordInteraction): number {
	return DISCORD_ATTACHMENT_OPTION_NAMES
		.map((optionName) => discordAttachmentFromOption(interaction, optionName))
		.filter(Boolean).length;
}

async function discordAttachments(interaction: DiscordInteraction): Promise<DiscordAttachmentSummary> {
	const selected = DISCORD_ATTACHMENT_OPTION_NAMES.map((optionName) => discordAttachmentFromOption(interaction, optionName)).filter((item): item is DiscordResolvedAttachment => Boolean(item));

	const attachments: EmailAttachment[] = [];
	const skipped: string[] = [];
	for (const item of selected) {
		const contentType = item.content_type || "";
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

function discordAck(content: string): Response {
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

function discordDeferredAck(): Response {
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

function discordSubmissionAck(editorialMode: string, attachmentSummary: DiscordAttachmentSummary): string {
	const mode = editorialMode === "agentic" ? "AI-edited" : "verbatim";
	const details: string[] = [];
	if (attachmentSummary.requested > 0) {
		details.push(`${attachmentSummary.attachments.length}/${attachmentSummary.requested} image attachment(s) accepted.`);
	}
	if (attachmentSummary.skipped.length > 0) {
		details.push(`Skipped: ${attachmentSummary.skipped.slice(0, 3).join("; ")}.`);
		if (attachmentSummary.skipped.length > 3) {
			details.push(`Plus ${attachmentSummary.skipped.length - 3} more skipped image(s).`);
		}
		details.push(DISCORD_FALLBACK_MESSAGE);
	}

	return `Got it. I started a ${mode} website update PR for review.${details.length ? `\n\n${details.join("\n")}` : ""}`;
}

async function discordFollowup(interaction: DiscordInteraction, content: string): Promise<void> {
	const applicationId = interaction.application_id;
	const token = interaction.token;
	if (!applicationId || !token) return;
	const response = await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${token}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			content,
			flags: DISCORD_MESSAGE_EPHEMERAL,
		}),
	});
	if (!response.ok) {
		throw new Error(`Discord follow-up failed: ${response.status} ${await response.text()}`);
	}
}

async function processDiscordCommandSubmission(env: WorkerEnv, interaction: DiscordInteraction, body: string, command: "recap" | "event" = "recap"): Promise<void> {
	const attachmentSummary = await discordAttachments(interaction);
	const editorialMode = command === "event" ? "agentic" : discordEditorialMode(interaction);
	const submittedBy = discordSubmittedBy(interaction);
	const links = discordLinks(interaction, body);
	const email: EmailPayload = {
		source: "discord",
		command,
		editorial_mode: editorialMode,
		submitted_by: submittedBy,
		from: submittedBy,
		subject: `Discord /${command}`,
		text: body,
		body,
		raw: "",
		attachments: attachmentSummary.attachments,
		links,
		discord_application_id: interaction.application_id || "",
		discord_interaction_token: interaction.token || "",
	};

	await dispatchToGitHub(env, email);
	await discordFollowup(interaction, discordSubmissionAck(editorialMode, attachmentSummary).replace("website update", command === "event" ? "calendar event" : "website update"));
}

function discordOpenRecapModal(defaultPolish: boolean): Response {
	return new Response(
		JSON.stringify({
			type: DISCORD_RESPONSE_MODAL,
			data: {
				custom_id: DISCORD_RECAP_MODAL_ID,
				title: "Create Dirigo recap",
				components: [
					{
						type: 1,
						components: [
							{
								type: 4,
								custom_id: "body",
								label: "Recap text",
								style: 2,
								required: true,
								max_length: 4000,
							},
						],
					},
					{
						type: 1,
						components: [
							{
								type: 4,
								custom_id: "links",
								label: "Source URLs (optional)",
								style: 2,
								required: false,
								max_length: 1000,
								placeholder: "Paste result links, one per line or spaced.",
							},
						],
					},
					{
						type: 1,
						components: [
							{
								type: 4,
								custom_id: "polish",
								label: "Polish wording? (yes/no)",
								style: 1,
								required: false,
								max_length: 8,
								value: defaultPolish ? "yes" : "no",
							},
						],
					},
				],
			},
		}),
		{ headers: { "content-type": "application/json" } },
	);
}

async function handleDiscordInteraction(
	request: Request,
	env: WorkerEnv,
	ctx: ExecutionContext,
	rawBody: Uint8Array,
): Promise<Response> {
	const verified = await verifyDiscordRequest(request, rawBody, env);
	if (!verified) {
		return new Response("Invalid request signature\n", { status: 401 });
	}

	let interaction: DiscordInteraction;
	try {
		interaction = JSON.parse(new TextDecoder().decode(rawBody)) as DiscordInteraction;
	} catch {
		return new Response("Invalid interaction payload\n", { status: 400 });
	}

	if (interaction.type === DISCORD_INTERACTION_PING) {
		return new Response(JSON.stringify({ type: DISCORD_RESPONSE_PONG }), {
			headers: { "content-type": "application/json" },
		});
	}

	if (interaction.type === DISCORD_INTERACTION_MODAL_SUBMIT && interaction.data?.custom_id === DISCORD_RECAP_MODAL_ID) {
		const body = discordModalInput(interaction, "body");
		if (!body) return discordAck("Please include recap text.");
		const linksField = discordModalInput(interaction, "links");
		const links = [...extractUrls(body), ...extractUrls(linksField)];
		const polish = parsePolish(discordModalInput(interaction, "polish"), parsePolish(discordModalInput(interaction, "agentic"), false));
		const submittedBy = discordSubmittedBy(interaction);
		const email: EmailPayload = {
			source: "discord",
			command: "recap",
			editorial_mode: polish ? "agentic" : "verbatim",
			submitted_by: submittedBy,
			from: submittedBy,
			subject: "Discord /recap",
			text: body,
			body,
			raw: "",
			links,
			discord_application_id: interaction.application_id || "",
			discord_interaction_token: interaction.token || "",
		};
		ctx.waitUntil(Promise.resolve().then(() => dispatchToGitHub(env, email)));
		if (polish) return discordAck("Got it. I started an AI-edited website update PR for review.");
		return discordAck("Got it. I started a verbatim website update PR for review.");
	}

	if (interaction.type !== DISCORD_INTERACTION_APPLICATION_COMMAND || !["recap", "event"].includes(interaction.data?.name || "")) {
		return discordAck("Unknown command.");
	}

	const command = normalizeCommand(interaction.data?.name);
	const body = String(discordOption(interaction, "body") || "").trim();
	const requestedAttachments = discordRequestedAttachmentCount(interaction);
	if (!body) {
		if (command === "event") {
			return discordAck("Please include event details in the body option.");
		}
		if (requestedAttachments > 0) {
			return discordAck(`Please include recap text in the inline body option when submitting image attachments. Discord modals cannot carry slash-command attachments.\n\n${DISCORD_FALLBACK_MESSAGE}`);
		}
		return discordOpenRecapModal(discordEditorialMode(interaction) === "agentic");
	}

	if (requestedAttachments > 0) {
		ctx.waitUntil(
			processDiscordCommandSubmission(env, interaction, body, command).catch((error: Error) => (
				discordFollowup(interaction, `I received the ${command === "event" ? "event details" : "recap text"}, but the background update failed: ${error.message}\n\n${DISCORD_FALLBACK_MESSAGE}`)
					.catch((followupError: Error) => console.error(followupError))
			)),
		);
		return discordDeferredAck();
	}

	const editorialMode = command === "event" ? "agentic" : discordEditorialMode(interaction);
	const submittedBy = discordSubmittedBy(interaction);
	const links = discordLinks(interaction, body);
	const attachmentSummary: DiscordAttachmentSummary = { attachments: [], skipped: [], requested: 0 };
	const email: EmailPayload = {
		source: "discord",
		command,
		editorial_mode: editorialMode,
		submitted_by: submittedBy,
		from: submittedBy,
		subject: `Discord /${command}`,
		text: body,
		body,
		raw: "",
		attachments: attachmentSummary.attachments,
		links,
		discord_application_id: interaction.application_id || "",
		discord_interaction_token: interaction.token || "",
	};

	ctx.waitUntil(Promise.resolve().then(() => dispatchToGitHub(env, email)));
	return discordAck(discordSubmissionAck(editorialMode, attachmentSummary).replace("website update", command === "event" ? "calendar event" : "website update"));
}

async function dispatchToGitHub(env: WorkerEnv, email: EmailPayload): Promise<void> {
	const repo = env.GITHUB_REPO || "dirigorc/dirigorc";
	const ingest = await createIngestPayload(env, email);
	const command = normalizeCommand(email.command || email.content_type);
	const eventType = DISPATCH_EVENT_TYPES[command] || DISPATCH_EVENT_TYPES.recap;
	const clientPayload: Record<string, unknown> = { ingest };
	if (email.source === "discord") {
		clientPayload.source = "discord";
		clientPayload.command = command;
		clientPayload.editorial_mode = email.editorial_mode || "verbatim";
		clientPayload.submitted_by = email.submitted_by || email.from || "Unknown Discord user";
		clientPayload.body = email.body || email.text || "";
		clientPayload.links = email.links || [];
		clientPayload.has_attachments = Array.isArray(email.attachments) && email.attachments.length > 0;
		if (email.discord_application_id && email.discord_interaction_token) {
			clientPayload.discord_callback = {
				application_id: email.discord_application_id,
				token: email.discord_interaction_token,
			};
		}
	}
	const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
		method: "POST",
		headers: {
			"Accept": "application/vnd.github+json",
			"Authorization": `Bearer ${env.GITHUB_TOKEN}`,
			"Content-Type": "application/json",
			"User-Agent": "dirigorc-race-report-worker",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		body: JSON.stringify({
			event_type: eventType,
			client_payload: clientPayload,
		}),
	});

	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`GitHub dispatch failed: ${response.status} ${detail}`);
	}
}

async function githubRequest(env: WorkerEnv, path: string, options: RequestInit = {}): Promise<unknown> {
	const repo = env.GITHUB_REPO || "dirigorc/dirigorc";
	const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
		...options,
		headers: {
			"Accept": "application/vnd.github+json",
			"Authorization": `Bearer ${env.GITHUB_TOKEN}`,
			"Content-Type": "application/json",
			"User-Agent": "dirigorc-race-report-worker",
			"X-GitHub-Api-Version": "2022-11-28",
			...(options.headers || {}),
		},
	});

	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`GitHub API failed: ${response.status} ${detail}`);
	}

	if (response.status === 204) return null;
	return response.json();
}

function textToBase64(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
}

function safeId(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "race-report";
}

async function createIngestPayload(env: WorkerEnv, email: EmailPayload): Promise<Record<string, string>> {
	const baseBranch = env.GITHUB_REF || "main";
	const command = normalizeCommand(email.command || email.content_type);
	const id = `${Date.now()}-${safeId(email.subject || command || "race-report")}`;
	const branch = `automation/email-ingest-${id}`;
	const path = `tmp/email-ingest/${id}/payload.json`;

	const baseRef = (await githubRequest(env, `/git/ref/heads/${baseBranch}`)) as { object: { sha: string } };
	await githubRequest(env, "/git/refs", {
		method: "POST",
		body: JSON.stringify({
			ref: `refs/heads/${branch}`,
			sha: baseRef.object.sha,
		}),
	});

	await githubRequest(env, `/contents/${path}`, {
		method: "PUT",
		body: JSON.stringify({
			message: `Stage ${command === "event" ? "calendar event" : "race report"} payload: ${email.subject || "Dirigo update"}`,
			branch,
			content: textToBase64(JSON.stringify({ email }, null, 2)),
		}),
	});

	return {
		branch,
		path,
		subject: email.subject || "Race report digest",
		from: email.from || "Unknown sender",
	};
}

async function emailPayloadFromRequest(request: Request): Promise<EmailPayload> {
	const contentType = request.headers.get("content-type") || "";
	const commandHeader = request.headers.get("x-dirigo-command") || request.headers.get("x-dirigo-content-type") || "";
	if (contentType.includes("application/json")) {
		const body = (await request.json()) as Record<string, unknown>;
		const attachments = Array.isArray(body.attachments) ? (body.attachments as EmailAttachment[]) : [];
		return {
			command: normalizeCommand(body.command || body.type || body.content_type || commandHeader),
			content_type: String(body.content_type || body.type || commandHeader || ""),
			from: String(body.from || body.sender || "HTTP webhook"),
			subject: String(body.subject || "Race report digest"),
			text: String(body.text || body.body || body.plain || ""),
			raw: String(body.raw || ""),
			attachments,
		};
	}

	const text = await request.text();
	return {
		command: normalizeCommand(commandHeader),
		content_type: commandHeader,
		from: request.headers.get("x-email-from") || "HTTP webhook",
		subject: request.headers.get("x-email-subject") || "Race report digest",
		text,
		raw: text,
	};
}

export default {
	async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Send POST requests to submit a race report digest or calendar event.\n", { status: 405 });
		}

		if (request.headers.has("x-signature-ed25519") || request.headers.has("x-signature-timestamp")) {
			const rawBody = new Uint8Array(await request.arrayBuffer());
			return handleDiscordInteraction(request, env, ctx, rawBody);
		}

		const expected = `Bearer ${env.INGEST_TOKEN}`;
		if (!env.INGEST_TOKEN || request.headers.get("authorization") !== expected) {
			return new Response("Unauthorized\n", { status: 401 });
		}

		const email = await emailPayloadFromRequest(request);
		if (!email.text && !email.raw) {
			return new Response("Missing email text/body\n", { status: 400 });
		}

		await dispatchToGitHub(env, email);
		return new Response(JSON.stringify({ ok: true }), {
			headers: { "content-type": "application/json" },
		});
	},

	async email(message: EmailMessage, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
		const from = message.from || headerValue(message.headers, "from");
		if (!allowedSender(from, env)) {
			message.setReject("Sender is not allowed to create Dirigo site updates.");
			return;
		}

		const raw = await new Response(message.raw).text();
		const email = {
			from,
			subject: headerValue(message.headers, "subject") || "Race report digest",
			text: raw,
			raw,
		};

		ctx.waitUntil(dispatchToGitHub(env, email));
	},
};
