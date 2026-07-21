import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import * as yauzl from "yauzl";
import { findSensitiveData } from "./redaction.js";

const MAX_SCAN_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024;
const SCAN_OVERLAP_CHARACTERS = 8_192;
const BINARY_TRACE_ENTRY = /\.(?:jpe?g|png|webp|gif|woff2?|ttf)$/i;

function isUnsafeArchivePath(value: string): boolean {
  if (!value || value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:\//.test(value)) return true;
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  return !normalized || normalized.split("/").some((segment) => segment === ".." || segment === "");
}

async function scanReadable(
  stream: NodeJS.ReadableStream,
  label: string,
  maximumBytes: number,
): Promise<void> {
  const decoder = new StringDecoder("utf8");
  let tail = "";
  let bytes = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > maximumBytes) throw new Error(`${label} exceeds the redaction scan size limit`);
    const text = tail + decoder.write(buffer);
    const finding = findSensitiveData(text);
    if (finding) throw new Error(`${label} contains possible ${finding}`);
    tail = text.slice(-SCAN_OVERLAP_CHARACTERS);
  }

  const finalText = tail + decoder.end();
  const finding = findSensitiveData(finalText);
  if (finding) throw new Error(`${label} contains possible ${finding}`);
}

export async function assertFileContainsNoSensitiveData(filePath: string, label: string): Promise<void> {
  await scanReadable(createReadStream(filePath), label, MAX_SCAN_BYTES);
}

export async function assertTraceContainsNoSensitiveData(filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error("Unable to open trace archive"));
        return;
      }

      let settled = false;
      let totalBytes = 0;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        zipFile.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      zipFile.on("error", fail);
      zipFile.on("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zipFile.on("entry", (entry) => {
        if (isUnsafeArchivePath(entry.fileName)) {
          fail(new Error(`Trace archive contains unsafe entry path: ${entry.fileName}`));
          return;
        }
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((unixMode & 0o170000) === 0o120000) {
          fail(new Error(`Trace archive contains a symbolic link: ${entry.fileName}`));
          return;
        }
        if (/\/$/.test(entry.fileName)) {
          zipFile.readEntry();
          return;
        }
        if (entry.uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES) {
          fail(new Error(`Trace archive entry is too large: ${entry.fileName}`));
          return;
        }
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_SCAN_BYTES) {
          fail(new Error("Trace archive exceeds the redaction scan size limit"));
          return;
        }
        // Binary images cannot be safely classified as text. They are permitted only because
        // the manifest binds this MVP to fixed synthetic data; all textual trace entries are scanned.
        if (BINARY_TRACE_ENTRY.test(entry.fileName)) {
          zipFile.readEntry();
          return;
        }

        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error(`Unable to read trace entry: ${entry.fileName}`));
            return;
          }
          void scanReadable(stream, `trace.zip:${entry.fileName}`, MAX_ARCHIVE_ENTRY_BYTES)
            .then(() => zipFile.readEntry(), fail);
        });
      });

      zipFile.readEntry();
    });
  });
}
