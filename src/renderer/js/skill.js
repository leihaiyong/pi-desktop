/**
 * Skill block parsing (mirrors pi's parseSkillBlock).
 * pi expands skill invocations into a `<skill name=... location=...>` block
 * that wraps the skill content and optional user message.
 */
export function parseSkillBlock(text) {
	const match = (text ?? "").match(
		/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/,
	);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}
