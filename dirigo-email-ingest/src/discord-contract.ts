import rawContract from "../discord-contract.json";

export type DiscordContract = {
	commands: readonly CommandSpec[];
	reviewActions: readonly ReviewActionSpec[];
};

export type CommandSpec = {
	name: string;
	dispatch: "race-report-email" | "calendar-event-email" | null;
	ingestAliases: readonly string[];
	registration: {
		name: string;
		description: string;
		type: 1;
		options: readonly Record<string, unknown>[];
	};
};

export type ReviewActionSpec = {
	action: string;
	label: string;
	style: 1 | 2 | 3;
	customIdPrefix: string;
	modalPrefix?: string;
};

const PREFIX = /^pr_[a-z]+$/;

let cached: DiscordContract | null = null;

export function loadDiscordContract(): DiscordContract {
	if (cached) return cached;
	cached = parseDiscordContract(rawContract);
	return cached;
}

function parseDiscordContract(value: unknown): DiscordContract {
	if (!isRecord(value)) throw new Error("Discord contract must be an object.");
	const commands = parseCommands(value.commands);
	const reviewActions = parseReviewActions(value.reviewActions);
	const names = commands.map((command) => command.name);
	if (new Set(names).size !== names.length) throw new Error("Discord contract command names must be unique.");

	const correctionCommands = commands.filter((command) => command.dispatch === null);
	if (correctionCommands.length !== 1) throw new Error("Discord contract must have exactly one command with a null dispatch.");
	const modalActions = reviewActions.filter((action) => action.modalPrefix);
	if (modalActions.length !== 1) throw new Error("Discord contract must have exactly one review action with a modal prefix.");
	if (correctionCommands[0].name !== modalActions[0].action) {
		throw new Error("The null-dispatch command must be the review action that opens a modal.");
	}

	const recap = commands.find((command) => command.name === "recap");
	const event = commands.find((command) => command.name === "event");
	if (!recap || recap.dispatch !== "race-report-email") throw new Error("Discord contract recap must dispatch race-report-email.");
	if (!event || event.dispatch !== "calendar-event-email") throw new Error("Discord contract event must dispatch calendar-event-email.");

	const aliasOwners = new Map<string, string>();
	for (const command of commands) {
		for (const alias of command.ingestAliases) {
			if (names.includes(alias)) throw new Error(`Discord contract alias ${alias} matches a command name.`);
			const owner = aliasOwners.get(alias);
			if (owner) throw new Error(`Discord contract alias ${alias} is used by ${owner} and ${command.name}.`);
			aliasOwners.set(alias, command.name);
		}
	}

	for (const actionName of ["publish", "hold"]) {
		const action = reviewActions.find((item) => item.action === actionName);
		if (!action) throw new Error(`Discord contract is missing the ${actionName} review action.`);
		if (action.modalPrefix) throw new Error(`Discord contract ${actionName} must not open a modal.`);
	}

	return { commands, reviewActions };
}

function parseCommands(value: unknown): CommandSpec[] {
	if (!Array.isArray(value)) throw new Error("Discord contract commands must be a list.");
	return value.map(parseCommand);
}

function parseCommand(value: unknown): CommandSpec {
	if (!isRecord(value)) throw new Error("Discord contract command must be an object.");
	const name = requiredString(value.name, "command name");
	const dispatch = parseDispatch(value.dispatch);
	if (!Array.isArray(value.ingestAliases) || value.ingestAliases.some((alias) => typeof alias !== "string")) {
		throw new Error(`Discord contract ${name} ingest aliases must be strings.`);
	}
	const registration = parseRegistration(value.registration, name);
	if (registration.name !== name) throw new Error(`Discord contract ${name} registration name must match.`);
	return {
		name,
		dispatch,
		ingestAliases: value.ingestAliases,
		registration,
	};
}

function parseDispatch(value: unknown): CommandSpec["dispatch"] {
	if (value === null) return null;
	if (value === "race-report-email" || value === "calendar-event-email") return value;
	throw new Error("Discord contract dispatch must be race-report-email, calendar-event-email, or null.");
}

function parseRegistration(value: unknown, commandName: string): CommandSpec["registration"] {
	if (!isRecord(value)) throw new Error(`Discord contract ${commandName} registration must be an object.`);
	if (value.type !== 1) throw new Error(`Discord contract ${commandName} registration type must be 1.`);
	if (!Array.isArray(value.options)) throw new Error(`Discord contract ${commandName} registration options must be a list.`);
	const options = value.options.filter(isRecord);
	if (options.length !== value.options.length) throw new Error(`Discord contract ${commandName} registration options must be objects.`);
	return {
		name: requiredString(value.name, `${commandName} registration name`),
		description: requiredString(value.description, `${commandName} registration description`),
		type: 1,
		options,
	};
}

function parseReviewActions(value: unknown): ReviewActionSpec[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
		throw new Error("Discord contract review actions must be one to five.");
	}
	const actions = value.map(parseReviewAction);
	const prefixes = actions.map((action) => action.customIdPrefix);
	if (new Set(prefixes).size !== prefixes.length) throw new Error("Discord contract review prefixes must be unique.");
	return actions;
}

function parseReviewAction(value: unknown): ReviewActionSpec {
	if (!isRecord(value)) throw new Error("Discord contract review action must be an object.");
	const customIdPrefix = requiredString(value.customIdPrefix, "review prefix");
	if (!PREFIX.test(customIdPrefix)) throw new Error(`Discord contract prefix ${customIdPrefix} must match pr_ plus letters.`);
	const style = value.style;
	if (style !== 1 && style !== 2 && style !== 3) throw new Error(`Discord contract prefix ${customIdPrefix} has an invalid style.`);
	const action: ReviewActionSpec = {
		action: requiredString(value.action, "review action"),
		label: requiredString(value.label, "review label"),
		style,
		customIdPrefix,
	};
	if ("modalPrefix" in value && value.modalPrefix !== undefined) {
		action.modalPrefix = requiredString(value.modalPrefix, "modal prefix");
	}
	return action;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value) throw new Error(`Discord contract ${label} must be a string.`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
