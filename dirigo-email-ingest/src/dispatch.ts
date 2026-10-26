import { loadDiscordContract } from "./discord-contract";
import type { ReportInference } from "./self-report";

export interface EmailAttachment {
	filename: string;
	content_type: string;
	data: string;
}

export interface WorkerEnv {
	GITHUB_TOKEN?: string;
	GITHUB_REPO?: string;
	GITHUB_REF?: string;
	INGEST_TOKEN?: string;
	ALLOWED_FROM?: string;
	DISCORD_PUBLIC_KEY?: string;
	DISCORD_PR_APPROVER_IDS?: string;
	DISCORD_BOT_TOKEN?: string;
	DISCORD_GUILD_ID?: string;
	DISCORD_RECAP_EMOJI?: string;
	DISCORD_GATEWAY?: DurableObjectNamespace;
}

export interface EmailPayload {
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
	correction?: CorrectionWire;
	inference?: ReportInference;
	trigger?: "reaction";
	authored_by?: string;
}

export type CorrectionWire = {
	instruction: string;
	instructionHash: string;
	marker: string;
	branch: string;
	path: string;
	readFrom: "main" | "branch";
	reviewMessages: { channelId: string; messageId: string }[];
	mode: "race-report" | "calendar-event";
};

export class CorrectionIngestError extends Error {
	constructor() {
		super("The correction command is not an email or HTTP ingest.");
		this.name = "CorrectionIngestError";
	}
}

export function ingestCommand(value: unknown): "recap" | "event" {
	const normalized = String(value ?? "").trim().toLowerCase();
	const contract = loadDiscordContract();
	const correction = contract.commands.find((command) => command.dispatch === null);
	if (correction && normalized === correction.name) throw new CorrectionIngestError();
	const event = contract.commands.find((command) => command.name === "event");
	if (normalized === "event" || event?.ingestAliases.some((alias) => alias.toLowerCase() === normalized)) return "event";
	return "recap";
}

export function ingestBranchName(id: string): string {
	return `automation/email-ingest-${id}`;
}

export async function githubFetch(env: WorkerEnv, path: string, options: RequestInit = {}): Promise<{ status: number; text: string }> {
	const repo = env.GITHUB_REPO || "dirigorc/dirigorc";
	const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
		...options,
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			"Content-Type": "application/json",
			"User-Agent": "dirigorc-race-report-worker",
			"X-GitHub-Api-Version": "2022-11-28",
			...(options.headers || {}),
		},
	});
	return { status: response.status, text: await response.text() };
}

export async function githubRequest(env: WorkerEnv, path: string, options: RequestInit = {}): Promise<unknown> {
	const result = await githubFetch(env, path, options);
	if (result.status === 204) return null;
	if (result.status < 200 || result.status >= 300) {
		throw new Error(`GitHub API failed: ${result.status} ${result.text}`);
	}
	return result.text ? JSON.parse(result.text) : null;
}

export function textToBase64(value: string): string {
	return bytesToBase64(new TextEncoder().encode(value));
}

export function base64ToText(value: string): string {
	const binary = atob(value.replace(/\s/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return new TextDecoder().decode(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
}

export async function createIngestBranch(env: WorkerEnv, branch: string): Promise<void> {
	const baseBranch = env.GITHUB_REF || "main";
	const baseRef = await githubRequest(env, `/git/ref/heads/${baseBranch}`);
	const sha = recordSha(baseRef);
	if (!sha) throw new Error("GitHub API failed: missing base branch sha.");
	await githubRequest(env, "/git/refs", {
		method: "POST",
		body: JSON.stringify({
			ref: `refs/heads/${branch}`,
			sha,
		}),
	});
}

export async function dispatchToGitHub(
	env: WorkerEnv,
	email: EmailPayload,
	options: {
		eventType?: "race-report-email" | "calendar-event-email";
		correction?: CorrectionWire;
		ingest?: Record<string, string>;
		includeBody?: boolean;
	} = {},
): Promise<void> {
	if (options.correction) email.correction = options.correction;
	let eventType = options.eventType;
	let command: "recap" | "event";
	if (eventType) {
		command = eventType === "calendar-event-email" ? "event" : "recap";
	} else {
		command = ingestCommand(email.command || email.content_type);
		eventType = command === "event" ? "calendar-event-email" : "race-report-email";
	}
	const repo = env.GITHUB_REPO || "dirigorc/dirigorc";
	const ingest = options.ingest || (await createIngestPayload(env, email));
	const clientPayload: Record<string, unknown> = { ingest };
	if (email.correction) clientPayload.correction = email.correction;
	if (email.source === "discord") {
		clientPayload.source = "discord";
		clientPayload.command = command;
		clientPayload.editorial_mode = email.editorial_mode || "verbatim";
		clientPayload.submitted_by = email.submitted_by || email.from || "Unknown Discord user";
		if (options.includeBody !== false) clientPayload.body = email.body || email.text || "";
		clientPayload.links = email.links || [];
		clientPayload.has_attachments = Array.isArray(email.attachments) && email.attachments.length > 0;
		if (email.discord_application_id && email.discord_interaction_token) {
			clientPayload.discord_callback = {
				application_id: email.discord_application_id,
				token: email.discord_interaction_token,
			};
		}
		if (email.inference) clientPayload.inference = email.inference;
		if (email.trigger) clientPayload.trigger = email.trigger;
		if (email.authored_by) clientPayload.authored_by = email.authored_by;
	}
	const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
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

export async function createIngestPayload(env: WorkerEnv, email: EmailPayload): Promise<Record<string, string>> {
	const label = email.correction ? "correction" : ingestCommand(email.command || email.content_type) === "event" ? "calendar event" : "race report";
	const id = `${Date.now()}-${safeId(email.subject || label)}`;
	const branch = ingestBranchName(id);
	const path = `tmp/email-ingest/${id}/payload.json`;

	await createIngestBranch(env, branch);

	await githubRequest(env, `/contents/${path}`, {
		method: "PUT",
		body: JSON.stringify({
			message: `Stage ${label} payload: ${email.subject || "Dirigo update"}`,
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

export function safeId(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "race-report";
}

function recordSha(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const object = "object" in value ? value.object : undefined;
	if (!object || typeof object !== "object" || !("sha" in object)) return "";
	return typeof object.sha === "string" ? object.sha : "";
}
