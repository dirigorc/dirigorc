/**
 * Cloudflare Worker endpoint for Dirigo race report emails.
 *
 * Supports two entry points:
 * - Email Routing Worker: attach this Worker to an address such as updates@dirigorc.com.
 * - Discord interactions endpoint for the /recap, /event, and /revise slash commands.
 * - Discord gateway for a recap emoji reaction on another member's message.
 * - HTTP POST webhook: send JSON or plain text to the Worker URL.
 *
 * Required Worker secrets/vars:
 * - GITHUB_TOKEN: Fine-grained GitHub token with Contents: write and Pull requests: write on dirigorc/dirigorc.
 * - GITHUB_REPO: "dirigorc/dirigorc"
 * - INGEST_TOKEN: Shared bearer token for HTTP POSTs.
 *
 * Optional vars:
 * - ALLOWED_FROM: Comma-separated sender allowlist for Email Routing.
 * - DISCORD_PUBLIC_KEY: Required only for the Discord interaction endpoint.
 * - DISCORD_PR_APPROVER_IDS: Discord user IDs allowed to publish, hold, or revise a draft. Defaults to Seth Crockett and Crow Norlander.
 * - DISCORD_BOT_TOKEN: Bot token used to update the other reviewer's message after Publish or Hold, and to read a reacted message.
 * - DISCORD_RECAP_EMOJI: Emoji that starts a recap from a message. Defaults to the checkered flag.
 * - DISCORD_GUILD_ID: Optional guild id. When set, reactions in other servers are ignored.
 */

import { loadDiscordContract } from "./discord-contract";
import {
	DISCORD_INTERACTION_APPLICATION_COMMAND,
	DISCORD_INTERACTION_MESSAGE_COMPONENT,
	DISCORD_INTERACTION_MODAL_SUBMIT,
	DISCORD_INTERACTION_PING,
	DISCORD_RESPONSE_MODAL,
	DISCORD_RESPONSE_PONG,
	type DiscordInteraction,
	discordAck,
	discordDeferredAck,
	discordFollowup,
	discordModalField,
	discordModalInput,
	discordOption,
	discordSubmittedBy,
	discordUser,
} from "./discord-reply";
import { ensureDiscordGateway, DiscordGateway } from "./discord-gateway";
import {
	CorrectionIngestError,
	type EmailAttachment,
	type EmailPayload,
	type WorkerEnv,
	base64ToText,
	createIngestBranch,
	dispatchToGitHub,
	githubFetch,
	githubRequest,
	ingestBranchName,
	safeId,
	textToBase64,
} from "./dispatch";
import { handleReviewInteraction } from "./review";
import {
	DATEISH_PATTERN,
	incompleteMemberNameReason,
	prepareRecap,
	recapClarificationReason,
	recapStartedMessage,
	reporterFromUser,
	type Reporter,
} from "./self-report";

loadDiscordContract();
const DISCORD_IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);
const DISCORD_TEXT_CONTENT_TYPES = new Set(["text/plain", "text/markdown", "message/rfc822", "application/octet-stream"]);
const MAX_DISCORD_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_DISCORD_TEXT_ATTACHMENT_BYTES = 256 * 1024;
const DISCORD_ATTACHMENT_OPTION_NAMES = ["image1", "image2", "image3", "image4", "image5"];
const DISCORD_TEXT_ATTACHMENT_OPTION_NAME = "recap_file";
const DISCORD_MODAL_BODY_MAX = 4000;
const DISCORD_RECAP_MODAL_ID = "recap_modal_v1";
const DISCORD_EVENT_MODAL_ID = "event_modal_v1";
const DISCORD_LONG_RECAP_MESSAGE = "Run /recap with an empty body and continue in the form when a box fills. To send a file instead, attach a .txt or .md file with recap_file.";
const DISCORD_FALLBACK_MESSAGE = "If Discord drops your submission while uploading images, submit the recap text first, attach a .txt/.md file with recap_file, or use the HTTP test endpoint in the README.";

export { DiscordGateway };

interface DiscordAttachmentSummary {
	attachments: EmailAttachment[];
	skipped: string[];
	requested: number;
}

interface DiscordTextAttachmentSummary {
	text: string;
	skipped: string[];
	requested: number;
	filename: string;
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

interface DiscordResolvedAttachment {
	id?: string;
	filename?: string;
	content_type?: string;
	size?: number;
	url?: string;
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

function wordCount(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

function interactionReporter(interaction: DiscordInteraction): Reporter {
	return reporterFromUser(discordUser(interaction));
}

function applySelfReport(interaction: DiscordInteraction, body: string, email: EmailPayload): EmailPayload {
	const requested = email.editorial_mode === "agentic" ? "agentic" : "verbatim";
	const prepared = prepareRecap(body, interactionReporter(interaction), Date.now(), requested);
	if (!prepared.inference) return { ...email, editorial_mode: prepared.editorialMode };
	return { ...email, editorial_mode: prepared.editorialMode, inference: prepared.inference };
}

function clarificationReason(command: "recap" | "event", body: string, requestedAttachments: number, reporter: Reporter | null = null): string {
	const trimmed = body.trim();
	const words = wordCount(trimmed);
	const hasDate = DATEISH_PATTERN.test(trimmed);
	const incompleteNameReason = incompleteMemberNameReason(trimmed);

	if (command === "event") {
		if (!trimmed) return "Please add the event name, date, time, location, and any useful links.";
		if (!hasDate) return "Please add the event date before I create a calendar PR.";
		if (words < 4) return "Please add a little more context, like the event name, location, and time.";
		if (incompleteNameReason) return incompleteNameReason;
		return "";
	}

	return recapClarificationReason(trimmed, reporter, requestedAttachments);
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

function attachmentContentType(item: DiscordResolvedAttachment): string {
	return String(item.content_type || "").split(";")[0].trim().toLowerCase();
}

function attachmentExtension(filename: string): string {
	const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
	return match ? match[1] : "";
}

function discordTextAttachmentFromOption(interaction: DiscordInteraction): DiscordResolvedAttachment | null {
	return discordAttachmentFromOption(interaction, DISCORD_TEXT_ATTACHMENT_OPTION_NAME);
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

export { discordAttachments };

async function discordTextAttachment(interaction: DiscordInteraction): Promise<DiscordTextAttachmentSummary> {
	const item = discordTextAttachmentFromOption(interaction);
	if (!item) return { text: "", skipped: [], requested: 0, filename: "" };

	const filename = item.filename || "recap.txt";
	const contentType = attachmentContentType(item);
	const extension = attachmentExtension(filename);
	const size = Number(item.size || 0);
	const url = item.url || "";
	const skipped: string[] = [];

	if (!url) skipped.push(`${filename}: missing Discord attachment URL`);
	if (!DISCORD_TEXT_CONTENT_TYPES.has(contentType) && !["txt", "md", "markdown", "eml"].includes(extension)) {
		skipped.push(`${filename}: attach a .txt, .md, or .eml recap file`);
	}
	if (size <= 0 || size > MAX_DISCORD_TEXT_ATTACHMENT_BYTES) {
		skipped.push(`${filename}: over the 256 KB recap-file limit`);
	}
	if (skipped.length > 0) return { text: "", skipped, requested: 1, filename };

	let response: Response;
	try {
		response = await fetch(url);
	} catch {
		return { text: "", skipped: [`${filename}: could not fetch from Discord`], requested: 1, filename };
	}
	if (!response.ok) {
		return { text: "", skipped: [`${filename}: Discord returned ${response.status}`], requested: 1, filename };
	}

	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0 || bytes.length > MAX_DISCORD_TEXT_ATTACHMENT_BYTES) {
		return { text: "", skipped: [`${filename}: empty or over the 256 KB recap-file limit`], requested: 1, filename };
	}

	return {
		text: new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes).trim(),
		skipped: [],
		requested: 1,
		filename,
	};
}

function discordSubmissionAck(editorialMode: string, attachmentSummary: DiscordAttachmentSummary): string {
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

	return `${recapStartedMessage(editorialMode)}${details.length ? `\n\n${details.join("\n")}` : ""}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runDiscordBackgroundTask(
	interaction: DiscordInteraction,
	command: "recap" | "event",
	task: () => Promise<void>,
): Promise<void> {
	try {
		await task();
	} catch (error) {
		const message = errorMessage(error);
		console.error(JSON.stringify({
			message: "Discord background submission failed",
			command,
			error: message,
		}));

		const submission = command === "event" ? "event details" : "recap text";
		try {
			await discordFollowup(
				interaction,
				`I received the ${submission}, but the background update failed: ${message}\n\nPlease retry /${command}.`,
			);
		} catch (followupError) {
			console.error(JSON.stringify({
				message: "Discord failure follow-up failed",
				command,
				error: errorMessage(followupError),
			}));
		}
	}
}

async function processDiscordCommandSubmission(env: WorkerEnv, interaction: DiscordInteraction, body: string, command: "recap" | "event" = "recap"): Promise<void> {
	const attachmentSummary = await discordAttachments(interaction);
	const editorialMode = command === "event" ? "agentic" : discordEditorialMode(interaction);
	const submittedBy = discordSubmittedBy(interaction);
	const links = discordLinks(interaction, body);
	let email: EmailPayload = {
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
	if (command === "recap") email = applySelfReport(interaction, body, email);

	await dispatchToGitHub(env, email);
	await discordFollowup(interaction, discordSubmissionAck(email.editorial_mode || editorialMode, attachmentSummary).replace("website update", command === "event" ? "calendar event" : "website update"));
}

async function processDiscordRecapFileSubmission(env: WorkerEnv, interaction: DiscordInteraction, inlineBody = ""): Promise<void> {
	const fileSummary = await discordTextAttachment(interaction);
	if (!fileSummary.text) {
		const detail = fileSummary.skipped.length ? `\n\n${fileSummary.skipped.join("\n")}` : "";
		await discordFollowup(interaction, `I could not read the recap file.${detail}\n\n${DISCORD_LONG_RECAP_MESSAGE}`);
		return;
	}

	const body = [inlineBody.trim(), fileSummary.text].filter(Boolean).join("\n\n").trim();
	const reason = clarificationReason("recap", body, discordRequestedAttachmentCount(interaction), interactionReporter(interaction));
	if (reason) {
		await discordFollowup(interaction, `${reason}\n\nPlease edit the recap file and rerun /recap.`);
		return;
	}

	await processDiscordCommandSubmission(env, interaction, body, "recap");
}

function discordOpenRecapModal(defaultPolish: boolean, body = "", links = "", reason = "", customId = DISCORD_RECAP_MODAL_ID): Response {
	return new Response(
		JSON.stringify({
			type: DISCORD_RESPONSE_MODAL,
			data: {
				custom_id: customId,
				title: reason ? "Clarify Dirigo recap" : "Create Dirigo recap",
				components: [
					...(reason ? [
						{
							type: 1,
							components: [
								{
									type: 4,
									custom_id: "reason",
									label: "What I need",
									style: 2,
									required: false,
									max_length: 300,
									value: reason,
								},
							],
						},
					] : []),
					{
						type: 1,
						components: [
							{
								type: 4,
								custom_id: "body",
									label: "Recap text",
									style: 2,
									required: true,
									max_length: DISCORD_MODAL_BODY_MAX,
									value: body.slice(0, DISCORD_MODAL_BODY_MAX),
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
								value: links.slice(0, 1000),
							},
						],
					},
					{
						type: 1,
						components: [
							{
								type: 4,
								custom_id: "polish",
								label: "Polish body wording? (yes/no)",
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

function discordOpenEventModal(body = "", links = "", reason = ""): Response {
	return new Response(
		JSON.stringify({
			type: DISCORD_RESPONSE_MODAL,
			data: {
				custom_id: DISCORD_EVENT_MODAL_ID,
				title: reason ? "Clarify Dirigo event" : "Create Dirigo event",
				components: [
					...(reason ? [
						{
							type: 1,
							components: [
								{
									type: 4,
									custom_id: "reason",
									label: "What I need",
									style: 2,
									required: false,
									max_length: 300,
									value: reason,
								},
							],
						},
					] : []),
					{
						type: 1,
						components: [
							{
								type: 4,
								custom_id: "body",
									label: "Event details",
									style: 2,
									required: true,
									max_length: DISCORD_MODAL_BODY_MAX,
									placeholder: "Event name, date, time, location, and what Dirigo should know.",
									value: body.slice(0, DISCORD_MODAL_BODY_MAX),
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
								placeholder: "Paste event, registration, results, or photo links.",
								value: links.slice(0, 1000),
							},
						],
					},
				],
			},
		}),
		{ headers: { "content-type": "application/json" } },
	);
}

type RecapDraftStatus = "open" | "dispatching" | "dispatched";

type RecapStoredAttachment = {
	filename: string;
	content_type: string;
	sha: string;
};

type RecapDraft = {
	id: string;
	branch: string;
	source: "discord";
	command: "recap";
	editorial_mode: "verbatim" | "agentic";
	reason: string;
	links: string;
	parts: string[];
	attachments: RecapStoredAttachment[];
	status: RecapDraftStatus;
	application_id: string;
	interaction_token: string;
};

type RecapEvent =
	| {
			type: "savePart";
			index: number;
			text: string;
			reason: string;
			links: string;
			editorial_mode: "verbatim" | "agentic";
			application_id: string;
			interaction_token: string;
	  }
	| {
			type: "finish";
			application_id: string;
			interaction_token: string;
	  }
	| { type: "dispatchResult"; ok: boolean };

type RecapOutcome = "saved" | "unchanged" | "dispatch" | "already-sending" | "already-dispatched" | "dispatched" | "reopened";

type RecapApplyResult = {
	draft: RecapDraft;
	changed: boolean;
	outcome: RecapOutcome;
};

type RecapControl =
	| { action: "modal" }
	| { action: "write"; id: string; polish: boolean }
	| { action: "part"; id: string; index: number }
	| { action: "more"; id: string; index: number; placeholder: string }
	| { action: "done"; id: string };

const RECAP_WRITE_ATTEMPTS = 3;
const GITHUB_CONTENTS_MAX_BYTES = 1_000_000;

function recapDraftPath(id: string): string {
	return `tmp/email-ingest/${id}/draft.json`;
}

function recapPayloadPath(id: string): string {
	return `tmp/email-ingest/${id}/payload.json`;
}

function recapAttachmentPath(id: string, name: string): string {
	return `tmp/email-ingest/${id}/attachments/${name}.json`;
}

function attachmentStorageName(filename: string, index: number): string {
	const cleaned = filename.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
	return `${index + 1}-${cleaned || "image"}`;
}

function parseRecapControl(customId: string): RecapControl | null {
	if (customId === DISCORD_RECAP_MODAL_ID) return { action: "modal" };
	const write = /^recap_write:([a-z0-9-]+)(?::([av]))?$/.exec(customId);
	if (write) return { action: "write", id: write[1], polish: write[2] === "a" };
	const part = /^recap_part:([a-z0-9-]+):(\d+)$/.exec(customId);
	if (part) return { action: "part", id: part[1], index: Number(part[2]) };
	const more = /^recap_more:([a-z0-9-]+):(\d+)(?::([A-Za-z0-9_-]*))?$/.exec(customId);
	if (more) return { action: "more", id: more[1], index: Number(more[2]), placeholder: more[3] ? decodeTail(more[3]) : "" };
	const done = /^recap_done:([a-z0-9-]+)$/.exec(customId);
	if (done) return { action: "done", id: done[1] };
	return null;
}

function tailToken(text: string): string {
	const tail = text.slice(-24);
	if (!tail) return "";
	return bytesToBase64(new TextEncoder().encode(tail)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeTail(token: string): string {
	try {
		const pad = token.length % 4 === 0 ? "" : "=".repeat(4 - (token.length % 4));
		const binary = atob(token.replace(/-/g, "+").replace(/_/g, "/") + pad);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		return new TextDecoder().decode(bytes);
	} catch {
		return "";
	}
}

function applyRecapEvent(draft: RecapDraft, event: RecapEvent): RecapApplyResult {
	if (event.type === "savePart") {
		if (draft.status === "dispatched") return { draft, changed: false, outcome: "unchanged" };
		if (draft.status !== "open" && draft.status !== "dispatching") return { draft, changed: false, outcome: "unchanged" };
		const text = event.text.slice(0, DISCORD_MODAL_BODY_MAX);
		if (draft.parts[event.index] !== undefined) {
			const sameInteraction = draft.application_id === event.application_id && draft.interaction_token === event.interaction_token;
			if (sameInteraction) return { draft, changed: false, outcome: "unchanged" };
			return {
				draft: { ...draft, application_id: event.application_id, interaction_token: event.interaction_token },
				changed: true,
				outcome: "unchanged",
			};
		}
		const parts = draft.parts.slice();
		parts[event.index] = text;
		return {
			draft: {
				...draft,
				parts,
				reason: event.index === 0 ? event.reason : draft.reason,
				links: event.index === 0 ? event.links : draft.links,
				editorial_mode: event.index === 0 ? event.editorial_mode : draft.editorial_mode,
				application_id: event.application_id,
				interaction_token: event.interaction_token,
			},
			changed: true,
			outcome: "saved",
		};
	}

	if (event.type === "finish") {
		if (draft.status === "dispatched") return { draft, changed: false, outcome: "already-dispatched" };
		if (draft.status === "dispatching") return { draft, changed: false, outcome: "already-sending" };
		return {
			draft: {
				...draft,
				status: "dispatching",
				application_id: event.application_id,
				interaction_token: event.interaction_token,
			},
			changed: true,
			outcome: "dispatch",
		};
	}

	if (draft.status !== "dispatching") return { draft, changed: false, outcome: "unchanged" };
	if (event.ok) return { draft: { ...draft, status: "dispatched" }, changed: true, outcome: "dispatched" };
	return { draft: { ...draft, status: "open" }, changed: true, outcome: "reopened" };
}

function parseRecapDraft(text: string): RecapDraft {
	const draft = JSON.parse(text) as RecapDraft;
	if (!draft?.id || !Array.isArray(draft.parts)) throw new Error("Recap draft is unreadable.");
	if (!Array.isArray(draft.attachments)) draft.attachments = [];
	if (draft.status !== "open" && draft.status !== "dispatching" && draft.status !== "dispatched") {
		throw new Error("Recap draft is unreadable.");
	}
	return draft;
}

function newRecapDraft(interaction: DiscordInteraction): RecapDraft {
	const id = `${Date.now()}-${safeId("discord-recap")}`;
	const polish = discordEditorialMode(interaction) === "agentic";
	return {
		id,
		branch: ingestBranchName(id),
		source: "discord",
		command: "recap",
		editorial_mode: polish ? "agentic" : "verbatim",
		reason: "",
		links: String(discordOption(interaction, "links") || ""),
		parts: [],
		attachments: [],
		status: "open",
		application_id: interaction.application_id || "",
		interaction_token: interaction.token || "",
	};
}

function savePartEvent(interaction: DiscordInteraction, index: number, text: string): RecapEvent {
	const polish = parsePolish(discordModalInput(interaction, "polish"), parsePolish(discordModalInput(interaction, "agentic"), false));
	return {
		type: "savePart",
		index,
		text,
		reason: discordModalInput(interaction, "reason"),
		links: discordModalInput(interaction, "links"),
		editorial_mode: polish ? "agentic" : "verbatim",
		application_id: interaction.application_id || "",
		interaction_token: interaction.token || "",
	};
}

function uniqueUrls(texts: string[]): string[] {
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const text of texts) {
		for (const url of extractUrls(text)) {
			if (seen.has(url)) continue;
			seen.add(url);
			unique.push(url);
		}
	}
	return unique;
}

function writeRecapComponents(id: string, polish: boolean): unknown[] {
	const mode = polish ? "a" : "v";
	return [
		{
			type: 1,
			components: [{ type: 2, style: 1, label: "Write recap", custom_id: `recap_write:${id}:${mode}` }],
		},
	];
}

function continueRecapComponents(id: string, nextIndex: number, previousText: string): unknown[] {
	const token = tailToken(previousText);
	const moreId = token ? `recap_more:${id}:${nextIndex}:${token}` : `recap_more:${id}:${nextIndex}`;
	return [
		{
			type: 1,
			components: [
				{ type: 2, style: 1, label: "Add more", custom_id: moreId },
				{ type: 2, style: 3, label: "Finish", custom_id: `recap_done:${id}` },
			],
		},
	];
}

function recapContinueNote(text: string, firstFullBox: boolean): string {
	if (text.length >= DISCORD_MODAL_BODY_MAX) {
		const ending = firstFullBox ? " A shorter box ends the recap." : "";
		return `Saved this part because the box is full.${ending} Click Add more to paste the next slice, or click Finish.`;
	}
	return "Saved this part. Click Add more to paste the next slice, or click Finish.";
}

function photosSavedNote(summary: DiscordAttachmentSummary): string {
	const saved = summary.attachments.length;
	const noun = saved === 1 ? "photo" : "photos";
	const lines = [`Saved ${saved} ${noun}. Click Write recap to start the recap.`];
	if (summary.skipped.length > 0) lines.push(`Skipped: ${summary.skipped.slice(0, 3).join("; ")}.`);
	return lines.join("\n\n");
}

function discordOpenRecapSliceModal(id: string, index: number, placeholder: string): Response {
	return new Response(
		JSON.stringify({
			type: DISCORD_RESPONSE_MODAL,
			data: {
				custom_id: `recap_part:${id}:${index}`,
				title: "Continue Dirigo recap",
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
								max_length: DISCORD_MODAL_BODY_MAX,
								...(placeholder ? { placeholder } : {}),
							},
						],
					},
				],
			},
		}),
		{ headers: { "content-type": "application/json" } },
	);
}

async function getGithubContent(env: WorkerEnv, branch: string, path: string): Promise<{ sha: string; text: string } | null> {
	const result = await githubFetch(env, `/contents/${path}?ref=${encodeURIComponent(branch)}`);
	if (result.status === 404) return null;
	if (result.status < 200 || result.status >= 300) {
		throw new Error(`GitHub API failed: ${result.status} ${result.text}`);
	}
	const parsed = JSON.parse(result.text) as { sha?: string; content?: string };
	if (!parsed.content || !parsed.sha) throw new Error(`GitHub API failed: missing content for ${path}`);
	return { sha: parsed.sha, text: base64ToText(parsed.content) };
}

async function putGithubContent(
	env: WorkerEnv,
	branch: string,
	path: string,
	content: string,
	sha: string | null,
	message: string,
): Promise<{ conflict: true } | { conflict: false; sha: string }> {
	const body: Record<string, string> = {
		message,
		branch,
		content: textToBase64(content),
	};
	if (sha) body.sha = sha;
	const result = await githubFetch(env, `/contents/${path}`, {
		method: "PUT",
		body: JSON.stringify(body),
	});
	if (result.status === 409) return { conflict: true };
	if (result.status < 200 || result.status >= 300) {
		throw new Error(`GitHub API failed: ${result.status} ${result.text}`);
	}
	const parsed = JSON.parse(result.text) as { content?: { sha?: string } };
	return { conflict: false, sha: parsed.content?.sha || "" };
}

async function commitRecapEvent(env: WorkerEnv, id: string, event: RecapEvent): Promise<RecapApplyResult> {
	const path = recapDraftPath(id);
	let branch = ingestBranchName(id);
	let loaded = await getGithubContent(env, branch, path);
	if (!loaded) throw new Error("Recap draft not found.");
	for (let attempt = 0; attempt < RECAP_WRITE_ATTEMPTS; attempt++) {
		const draft = parseRecapDraft(loaded.text);
		branch = draft.branch || branch;
		const applied = applyRecapEvent(draft, event);
		if (!applied.changed) return applied;
		const put = await putGithubContent(env, branch, path, JSON.stringify(applied.draft, null, 2), loaded.sha, `Update recap draft ${id}`);
		if (!put.conflict) return applied;
		const again = await getGithubContent(env, branch, path);
		if (!again) throw new Error("Recap draft not found.");
		loaded = again;
	}
	throw new Error(`GitHub API failed: 409 recap draft ${id}`);
}

function utf8Base64(value: string): string {
	return bytesToBase64(new TextEncoder().encode(value));
}

async function createGitBlob(env: WorkerEnv, base64: string): Promise<string> {
	const result = await githubFetch(env, "/git/blobs", {
		method: "POST",
		body: JSON.stringify({ content: base64, encoding: "base64" }),
	});
	if (result.status < 200 || result.status >= 300) {
		throw new Error(`GitHub API failed: ${result.status} ${result.text}`);
	}
	const parsed = JSON.parse(result.text) as { sha?: string };
	if (!parsed.sha) throw new Error("GitHub API failed: missing blob sha");
	return parsed.sha;
}

async function readGitBlob(env: WorkerEnv, sha: string): Promise<Uint8Array> {
	const repo = env.GITHUB_REPO || "dirigorc/dirigorc";
	const response = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${sha}`, {
		headers: {
			Accept: "application/vnd.github.raw",
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			"User-Agent": "dirigorc-race-report-worker",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (!response.ok) throw new Error(`GitHub API failed: ${response.status} ${await response.text()}`);
	return new Uint8Array(await response.arrayBuffer());
}

async function commitTree(
	env: WorkerEnv,
	branch: string,
	entries: Array<{ path: string; sha: string }>,
	message: string,
): Promise<void> {
	const ref = (await githubRequest(env, `/git/ref/heads/${branch}`)) as { object: { sha: string } };
	const parent = (await githubRequest(env, `/git/commits/${ref.object.sha}`)) as { tree: { sha: string } };
	const tree = (await githubRequest(env, "/git/trees", {
		method: "POST",
		body: JSON.stringify({
			base_tree: parent.tree.sha,
			tree: entries.map((entry) => ({ path: entry.path, mode: "100644", type: "blob", sha: entry.sha })),
		}),
	})) as { sha: string };
	const commit = (await githubRequest(env, "/git/commits", {
		method: "POST",
		body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }),
	})) as { sha: string };
	await githubRequest(env, `/git/refs/heads/${branch}`, {
		method: "PATCH",
		body: JSON.stringify({ sha: commit.sha }),
	});
}

async function beginRecapDraftFromImages(env: WorkerEnv, interaction: DiscordInteraction): Promise<void> {
	const summary = await discordAttachments(interaction);
	const draft = newRecapDraft(interaction);
	await createIngestBranch(env, draft.branch);
	const entries: Array<{ path: string; sha: string }> = [];
	for (let index = 0; index < summary.attachments.length; index++) {
		const attachment = summary.attachments[index];
		const name = attachmentStorageName(attachment.filename, index);
		// The contents API drops file bodies over 1 MB. A race photo's base64 crosses that line.
		const sha = await createGitBlob(env, attachment.data);
		draft.attachments.push({ filename: attachment.filename, content_type: attachment.content_type, sha });
		entries.push({ path: recapAttachmentPath(draft.id, name), sha });
	}
	const draftText = JSON.stringify(draft, null, 2);
	entries.push({ path: recapDraftPath(draft.id), sha: await createGitBlob(env, utf8Base64(draftText)) });
	await commitTree(env, draft.branch, entries, `Stage recap draft ${draft.id}`);
	await discordFollowup(interaction, photosSavedNote(summary), writeRecapComponents(draft.id, draft.editorial_mode === "agentic"));
}

async function beginRecapDraftFromFullModal(env: WorkerEnv, interaction: DiscordInteraction, body: string): Promise<void> {
	const draft = newRecapDraft(interaction);
	const event = savePartEvent(interaction, 0, body);
	const applied = applyRecapEvent(draft, event);
	await createIngestBranch(env, applied.draft.branch);
	const put = await putGithubContent(
		env,
		applied.draft.branch,
		recapDraftPath(applied.draft.id),
		JSON.stringify(applied.draft, null, 2),
		null,
		`Stage recap draft ${applied.draft.id}`,
	);
	if (put.conflict) await commitRecapEvent(env, applied.draft.id, event);
	await discordFollowup(interaction, recapContinueNote(body, true), continueRecapComponents(applied.draft.id, 1, body));
}

async function saveRecapPart(env: WorkerEnv, interaction: DiscordInteraction, id: string, index: number, body: string): Promise<void> {
	const applied = await commitRecapEvent(env, id, savePartEvent(interaction, index, body));
	if (applied.outcome === "saved") {
		await discordFollowup(interaction, recapContinueNote(body, false), continueRecapComponents(id, index + 1, body));
		return;
	}
	if (applied.draft.status === "dispatched") {
		await discordFollowup(interaction, "This recap is already in review.");
		return;
	}
	if (applied.draft.status === "dispatching") {
		await discordFollowup(interaction, "This recap is already sending.");
		return;
	}
	const note = "This part is already saved. Click Add more to paste the next slice, or click Finish.";
	await discordFollowup(interaction, note, continueRecapComponents(id, index + 1, body));
}

async function buildRecapEmail(env: WorkerEnv, draft: RecapDraft, interaction: DiscordInteraction): Promise<EmailPayload> {
	const attachments: EmailAttachment[] = [];
	for (const attachment of draft.attachments) {
		const bytes = await readGitBlob(env, attachment.sha);
		attachments.push({
			filename: attachment.filename,
			content_type: attachment.content_type,
			data: bytesToBase64(bytes),
		});
	}
	const text = draft.parts.join("");
	const submittedBy = discordSubmittedBy(interaction);
	return applySelfReport(interaction, text, {
		source: "discord",
		command: "recap",
		editorial_mode: draft.editorial_mode,
		submitted_by: submittedBy,
		from: submittedBy,
		subject: "Discord /recap",
		text,
		body: text,
		raw: "",
		attachments,
		links: uniqueUrls([text, draft.links]),
		discord_application_id: interaction.application_id || draft.application_id,
		discord_interaction_token: interaction.token || draft.interaction_token,
	});
}

async function stageRecapPayload(env: WorkerEnv, draft: RecapDraft, interaction: DiscordInteraction): Promise<EmailPayload> {
	const email = await buildRecapEmail(env, draft, interaction);
	const path = recapPayloadPath(draft.id);
	const content = JSON.stringify({ email }, null, 2);
	const message = `Stage race report payload: ${email.subject}`;
	if (new TextEncoder().encode(content).length > GITHUB_CONTENTS_MAX_BYTES) {
		const sha = await createGitBlob(env, utf8Base64(content));
		await commitTree(env, draft.branch, [{ path, sha }], message);
		return email;
	}
	let existing = await getGithubContent(env, draft.branch, path);
	for (let attempt = 0; attempt < RECAP_WRITE_ATTEMPTS; attempt++) {
		const put = await putGithubContent(env, draft.branch, path, content, existing?.sha || null, message);
		if (!put.conflict) return email;
		existing = await getGithubContent(env, draft.branch, path);
	}
	throw new Error(`GitHub API failed: 409 recap payload ${draft.id}`);
}

function recapSentPath(id: string): string {
	return `tmp/email-ingest/${id}/sent.json`;
}

async function githubPathExists(env: WorkerEnv, branch: string, path: string): Promise<boolean> {
	const result = await githubFetch(env, `/contents/${path}?ref=${encodeURIComponent(branch)}`);
	return result.status >= 200 && result.status < 300;
}

async function loadRecapDraft(env: WorkerEnv, id: string): Promise<RecapDraft> {
	const loaded = await getGithubContent(env, ingestBranchName(id), recapDraftPath(id));
	if (!loaded) throw new Error("Recap draft not found.");
	return parseRecapDraft(loaded.text);
}

async function finishRecapDraft(env: WorkerEnv, interaction: DiscordInteraction, id: string): Promise<void> {
	const applied = await commitRecapEvent(env, id, {
		type: "finish",
		application_id: interaction.application_id || "",
		interaction_token: interaction.token || "",
	});
	if (applied.outcome === "already-dispatched") {
		await discordFollowup(interaction, "This recap is already in review.");
		return;
	}
	if (applied.outcome === "already-sending") {
		const pending = await loadRecapDraft(env, id);
		if (await githubPathExists(env, pending.branch, recapSentPath(pending.id))) {
			try {
				await commitRecapEvent(env, id, { type: "dispatchResult", ok: true });
			} catch (error) {
				console.error(JSON.stringify({ message: "Recap draft status update failed", error: errorMessage(error) }));
			}
			await discordFollowup(interaction, "This recap was already sent for review.");
			return;
		}
	} else if (applied.outcome !== "dispatch") {
		await discordFollowup(interaction, "This recap is already in review.");
		return;
	}

	const draft = await loadRecapDraft(env, id);
	let email: EmailPayload;
	try {
		email = await stageRecapPayload(env, draft, interaction);
		const reason = clarificationReason("recap", email.body || "", draft.attachments.length, interactionReporter(interaction));
		if (reason) {
			await commitRecapEvent(env, id, { type: "dispatchResult", ok: false });
			await discordFollowup(interaction, `${reason}\n\nAdd the missing detail with Add more, then click Finish.`);
			return;
		}
		await dispatchToGitHub(env, email, {
			includeBody: false,
			ingest: {
				branch: draft.branch,
				path: recapPayloadPath(draft.id),
				subject: email.subject || "Discord /recap",
				from: email.from,
			},
		});
	} catch (error) {
		try {
			await commitRecapEvent(env, id, { type: "dispatchResult", ok: false });
		} catch (revertError) {
			console.error(JSON.stringify({
				message: "Recap draft revert failed",
				error: errorMessage(revertError),
			}));
		}
		console.error(JSON.stringify({
			message: "Discord background submission failed",
			command: "recap",
			error: errorMessage(error),
		}));
		await discordFollowup(interaction, `I received the recap text, but the background update failed: ${errorMessage(error)}\n\nClick Finish to try again.`);
		return;
	}

	try {
		await putGithubContent(env, draft.branch, recapSentPath(draft.id), JSON.stringify({ sent: true }), null, `Mark recap dispatch sent ${draft.id}`);
	} catch (error) {
		console.error(JSON.stringify({ message: "Recap dispatch marker failed", error: errorMessage(error) }));
	}
	try {
		await commitRecapEvent(env, id, { type: "dispatchResult", ok: true });
	} catch (error) {
		console.error(JSON.stringify({ message: "Recap draft status update failed", error: errorMessage(error) }));
	}
	const attachments = email.attachments || [];
	await discordFollowup(
		interaction,
		discordSubmissionAck(email.editorial_mode || draft.editorial_mode, { attachments, skipped: [], requested: attachments.length }),
	);
}

function openRecapPartModal(control: RecapControl): Response {
	if (control.action === "write") {
		return discordOpenRecapModal(control.polish, "", "", "", `recap_part:${control.id}:0`);
	}
	if (control.action === "more") {
		return discordOpenRecapSliceModal(control.id, control.index, control.placeholder);
	}
	return discordAck("Unknown command.");
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

	ctx.waitUntil(ensureDiscordGateway(env));
	return routeDiscordInteraction(interaction, env, ctx);
}

export async function routeDiscordInteraction(
	interaction: DiscordInteraction,
	env: WorkerEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	if (interaction.type === DISCORD_INTERACTION_PING) {
		return new Response(JSON.stringify({ type: DISCORD_RESPONSE_PONG }), {
			headers: { "content-type": "application/json" },
		});
	}

	const review = await handleReviewInteraction(interaction, env, ctx);
	if (review) return review;

	const spec = loadDiscordContract().commands.find((command) => command.name === interaction.data?.name);
	if (interaction.type === DISCORD_INTERACTION_APPLICATION_COMMAND && (!spec || spec.dispatch === null)) {
		return discordAck("Unknown command.");
	}

	if (interaction.type === DISCORD_INTERACTION_MODAL_SUBMIT) {
		const control = parseRecapControl(interaction.data?.custom_id || "");
		if (control?.action === "part") {
			const raw = discordModalField(interaction, "body");
			if (!raw.trim()) return discordAck("Please include recap text.");
			const part = control;
			ctx.waitUntil(runDiscordBackgroundTask(interaction, "recap", () => saveRecapPart(env, interaction, part.id, part.index, raw.slice(0, DISCORD_MODAL_BODY_MAX))));
			return discordDeferredAck();
		}
	}

	if (interaction.type === DISCORD_INTERACTION_MODAL_SUBMIT && parseRecapControl(interaction.data?.custom_id || "")?.action === "modal") {
		const raw = discordModalField(interaction, "body");
		// Discord counts whitespace toward the 4,000 character cap, so a trimmed length would miss a full paste.
		if (raw.length >= DISCORD_MODAL_BODY_MAX) {
			ctx.waitUntil(runDiscordBackgroundTask(interaction, "recap", () => beginRecapDraftFromFullModal(env, interaction, raw.slice(0, DISCORD_MODAL_BODY_MAX))));
			return discordDeferredAck();
		}
		const body = raw.trim();
		if (!body) return discordAck("Please include recap text.");
		const reporter = interactionReporter(interaction);
		const reason = clarificationReason("recap", body, 0, reporter);
		if (reason) return discordAck(`${reason}\n\nPlease rerun /recap with the full names in the body.`);
		const linksField = discordModalInput(interaction, "links");
		const links = [...extractUrls(body), ...extractUrls(linksField)];
		const polish = parsePolish(discordModalInput(interaction, "polish"), parsePolish(discordModalInput(interaction, "agentic"), false));
		const submittedBy = discordSubmittedBy(interaction);
		const email = applySelfReport(interaction, body, {
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
		});
		ctx.waitUntil(runDiscordBackgroundTask(interaction, "recap", () => dispatchToGitHub(env, email)));
		return discordAck(recapStartedMessage(email.editorial_mode || "verbatim"));
	}

	if (interaction.type === DISCORD_INTERACTION_MODAL_SUBMIT && interaction.data?.custom_id === DISCORD_EVENT_MODAL_ID) {
		const body = discordModalInput(interaction, "body");
		if (!body) return discordAck("Please include event details.");
		const reason = clarificationReason("event", body, 0);
		if (reason) return discordAck(`${reason}\n\nPlease rerun /event with the full names in the body.`);
		const linksField = discordModalInput(interaction, "links");
		const links = [...extractUrls(body), ...extractUrls(linksField)];
		const submittedBy = discordSubmittedBy(interaction);
		const email: EmailPayload = {
			source: "discord",
			command: "event",
			editorial_mode: "agentic",
			submitted_by: submittedBy,
			from: submittedBy,
			subject: "Discord /event",
			text: body,
			body,
			raw: "",
			links,
			discord_application_id: interaction.application_id || "",
			discord_interaction_token: interaction.token || "",
		};
		ctx.waitUntil(runDiscordBackgroundTask(interaction, "event", () => dispatchToGitHub(env, email)));
		return discordAck("Got it. I started a calendar event PR for review.");
	}

	if (interaction.type === DISCORD_INTERACTION_MESSAGE_COMPONENT) {
		const customId = interaction.data?.custom_id || "";
		const control = parseRecapControl(customId);
		if (control?.action === "write" || control?.action === "more") return openRecapPartModal(control);
		if (control?.action === "done") {
			const done = control;
			ctx.waitUntil(runDiscordBackgroundTask(interaction, "recap", () => finishRecapDraft(env, interaction, done.id)));
			return discordDeferredAck();
		}
		return discordAck("Unknown command.");
	}

	if (interaction.type !== DISCORD_INTERACTION_APPLICATION_COMMAND || !spec || (spec.name !== "recap" && spec.name !== "event")) {
		return discordAck("Unknown command.");
	}

	const command = spec.name;
	const body = String(discordOption(interaction, "body") || "").trim();
	const linksField = String(discordOption(interaction, "links") || "").trim();
	const requestedAttachments = discordRequestedAttachmentCount(interaction);
	const hasRecapFile = command === "recap" && Boolean(discordTextAttachmentFromOption(interaction));
	if (!body) {
		if (command === "event") {
			return discordOpenEventModal("", linksField, clarificationReason(command, body, requestedAttachments));
		}
		if (hasRecapFile) {
			ctx.waitUntil(
				runDiscordBackgroundTask(interaction, "recap", () => processDiscordRecapFileSubmission(env, interaction)),
			);
			return discordDeferredAck();
		}
		if (requestedAttachments > 0) {
			ctx.waitUntil(runDiscordBackgroundTask(interaction, "recap", () => beginRecapDraftFromImages(env, interaction)));
			return discordDeferredAck();
		}
		return discordOpenRecapModal(discordEditorialMode(interaction) === "agentic");
	}

	if (command === "recap" && body.length > DISCORD_MODAL_BODY_MAX - 100 && !hasRecapFile) {
		return discordAck(DISCORD_LONG_RECAP_MESSAGE);
	}

	if (hasRecapFile) {
		ctx.waitUntil(
			runDiscordBackgroundTask(interaction, "recap", () => processDiscordRecapFileSubmission(env, interaction, body)),
		);
		return discordDeferredAck();
	}

	const reason = clarificationReason(command, body, requestedAttachments, command === "recap" ? interactionReporter(interaction) : null);
	if (reason) {
		if (requestedAttachments > 0) {
			return discordAck(`${reason}\n\nWhen submitting image attachments, Discord modals cannot carry the files forward. Please rerun /${command} with the missing details in the body and reattach the images.`);
		}
		if (command === "event") return discordOpenEventModal(body, linksField, reason);
		return discordOpenRecapModal(discordEditorialMode(interaction) === "agentic", body, linksField, reason);
	}

	if (requestedAttachments > 0) {
		ctx.waitUntil(
			runDiscordBackgroundTask(interaction, command, () => processDiscordCommandSubmission(env, interaction, body, command)),
		);
		return discordDeferredAck();
	}

	const editorialMode = command === "event" ? "agentic" : discordEditorialMode(interaction);
	const submittedBy = discordSubmittedBy(interaction);
	const links = discordLinks(interaction, body);
	const attachmentSummary: DiscordAttachmentSummary = { attachments: [], skipped: [], requested: 0 };
	let email: EmailPayload = {
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
	if (command === "recap") email = applySelfReport(interaction, body, email);

	ctx.waitUntil(runDiscordBackgroundTask(interaction, command, () => dispatchToGitHub(env, email)));
	return discordAck(discordSubmissionAck(email.editorial_mode || editorialMode, attachmentSummary).replace("website update", command === "event" ? "calendar event" : "website update"));
}

async function emailPayloadFromRequest(request: Request): Promise<EmailPayload> {
	const contentType = request.headers.get("content-type") || "";
	const commandHeader = request.headers.get("x-dirigo-command") || request.headers.get("x-dirigo-content-type") || "";
	if (contentType.includes("application/json")) {
		const body = (await request.json()) as Record<string, unknown>;
		const attachments = Array.isArray(body.attachments) ? (body.attachments as EmailAttachment[]) : [];
		return {
			command: String(body.command || body.type || body.content_type || commandHeader || ""),
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
		command: commandHeader,
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

		try {
			const email = await emailPayloadFromRequest(request);
			if (!email.text && !email.raw) {
				return new Response("Missing email text/body\n", { status: 400 });
			}
			await dispatchToGitHub(env, email);
		} catch (error) {
			if (error instanceof CorrectionIngestError) {
				return new Response("The correction command is not accepted on this endpoint.\n", { status: 400 });
			}
			throw error;
		}
		return new Response(JSON.stringify({ ok: true }), {
			headers: { "content-type": "application/json" },
		});
	},

	async scheduled(_event: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(ensureDiscordGateway(env));
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
