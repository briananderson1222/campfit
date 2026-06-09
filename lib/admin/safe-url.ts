export function safeExternalHref(value: string | null | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function displayExternalUrl(value: string, maxLength?: number): string {
  const display = value.replace(/^https?:\/\//, '');
  return typeof maxLength === 'number' && display.length > maxLength
    ? display.slice(0, maxLength)
    : display;
}
