/**
 * Pure helpers for editing the global models.json (custom provider config).
 *
 * models.json shape (see https://pi.dev/docs/latest/models):
 *   { "providers": { "<id>": { baseUrl?, apiKey?, api?, authHeader?,
 *                              headers?, models?: [ { id, name?, contextWindow?,
 *                                                    maxTokens?, reasoning?,
 *                                                    input?, cost?, ... } ] } } }
 *
 * `cost` values in the file are already dollars per 1M tokens (e.g.
 * { "input": 5 } = $5 per 1M tokens); the UI edits them as-is.
 */

export const MODELS_JSON_FILE = "models.json";

/** Parse models.json text. Never throws; malformed input -> { ok: false }. */
export function parseModelsJson(text) {
	let doc;
	try {
		doc = JSON.parse(text);
	} catch (error) {
		return { ok: false, error: String(error), providers: {} };
	}
	const providers =
		doc &&
		typeof doc === "object" &&
		!Array.isArray(doc) &&
		doc.providers &&
		typeof doc.providers === "object" &&
		!Array.isArray(doc.providers)
			? doc.providers
			: {};
	return { ok: true, providers };
}

/** Serialize a providers map back to models.json text (2-space indent). */
export function serializeModelsJson(providers) {
	return JSON.stringify({ providers }, null, 2) + "\n";
}

/** Drop undefined values so cleared form fields remove keys on save. */
export function stripUndefined(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) out[k] = v;
	}
	return out;
}

/** Return a new providers map with `draft` merged over the provider at `id`.
 * Unknown fields already in the file are preserved. */
export function upsertProvider(providers, id, draft) {
	const next = { ...providers };
	next[id] = { ...(next[id] ?? {}), ...stripUndefined(draft) };
	return next;
}

/** Return a new providers map without the provider at `id`. */
export function removeProvider(providers, id) {
	const next = { ...providers };
	delete next[id];
	return next;
}

/** Return a new provider object with `draft` replacing the model at `id`
 * (appended when new). */
export function upsertModel(provider, draft) {
	const models = (provider.models ?? []).filter((m) => m.id !== draft.id);
	models.push(stripUndefined(draft));
	return { ...provider, models };
}

/** Return a new provider object without the model at `modelId`. */
export function removeModel(provider, modelId) {
	return { ...provider, models: (provider.models ?? []).filter((m) => m.id !== modelId) };
}

/** Update the input/output $-per-1M-token cost fields from raw UI values.
 * Unknown cost keys (cacheRead/cacheWrite/tiers) are preserved; returns
 * undefined when no cost fields remain (omitted from the file). */
export function updateCostFields(cost, inputRaw, outputRaw) {
	const out = { ...(cost ?? {}) };
	for (const [key, raw] of Object.entries({ input: inputRaw, output: outputRaw })) {
		const s = String(raw ?? "").trim();
		const n = Number(s);
		if (s && Number.isFinite(n) && n >= 0) out[key] = n;
		else delete out[key];
	}
	return Object.keys(out).length ? out : undefined;
}
