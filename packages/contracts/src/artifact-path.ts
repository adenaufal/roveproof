const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

function isSafeArtifactPathSegment(segment: string): boolean {
  if (segment === "." || segment === ".." || !SAFE_SEGMENT.test(segment)) return false;
  if (segment.endsWith(".") || segment.endsWith(" ")) return false;

  const basename = segment.split(".", 1)[0];
  return !WINDOWS_RESERVED_BASENAME.test(basename);
}

export function isSafeArtifactPath(value: string): boolean {
  if (value.length === 0 || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(value)) return false;

  return value.split("/").every(isSafeArtifactPathSegment);
}

export function assertSafeArtifactPath(value: string): string {
  if (!isSafeArtifactPath(value)) throw new Error(`Unsafe artifact path: ${JSON.stringify(value)}`);
  return value;
}
