export function composePrompt(message: string, prefix?: string): string {
  const normalizedPrefix = prefix?.trim() ?? "";
  if (!normalizedPrefix) return message;
  if (!message) return normalizedPrefix;
  return `${normalizedPrefix}\n\n${message}`;
}
