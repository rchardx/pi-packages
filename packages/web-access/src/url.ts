export const MAX_FETCH_URL_CHARACTERS = 8192;

export function normalizeFetchUrl(
  input: string,
  label = "Fetch",
  maxCharacters = MAX_FETCH_URL_CHARACTERS,
): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid URL; provide an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }
  url.hash = "";
  // Normalization can expand non-ASCII input beyond the registered input limit.
  if (url.href.length > maxCharacters) {
    throw new Error(`${label} URL exceeds ${maxCharacters} characters after normalization.`);
  }
  return url.href;
}

export function normalizeSourceUrl(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    return undefined;
  }
  return url.href;
}
