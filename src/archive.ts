import { inflateRawSync } from "node:zlib";

import type { ArchiveEntryIndex, ParsedArchive } from "./types.js";

const DATA_DESCRIPTOR_SIGNATURE = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
const ENCRYPTED_TAIL_MARKER = "OPCPLT_V001";
const ENCRYPTED_TAIL_MARKER_BUFFER = Buffer.from(ENCRYPTED_TAIL_MARKER, "ascii");

function looksLikeLocalHeader(buffer: Buffer, offset: number): boolean {
  if (offset + 30 > buffer.length) {
    return false;
  }

  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraFieldLength = buffer.readUInt16LE(offset + 28);
  if (fileNameLength <= 0 || fileNameLength > 2048 || extraFieldLength > 65535) {
    return false;
  }

  const nameStart = offset + 30;
  const nameEnd = nameStart + fileNameLength;
  if (nameEnd > buffer.length) {
    return false;
  }

  const name = buffer.toString("utf8", nameStart, nameEnd);
  if (!name) {
    return false;
  }

  return /^[A-Za-z0-9_./-]+$/.test(name);
}

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint >= 0 && codePoint <= 0x1f) {
      return true;
    }
  }

  return false;
}

function findDataDescriptorOffset(
  buffer: Buffer,
  dataStart: number,
): { descriptorOffset: number; compressedSize: number; crc32: number; uncompressedSize: number } {
  let cursor = dataStart;
  while (cursor < buffer.length) {
    const descriptorOffset = buffer.indexOf(DATA_DESCRIPTOR_SIGNATURE, cursor);
    if (descriptorOffset === -1) {
      break;
    }

    if (descriptorOffset + 16 > buffer.length) {
      break;
    }

    const crc32 = buffer.readUInt32LE(descriptorOffset + 4);
    const compressedSize = buffer.readUInt32LE(descriptorOffset + 8);
    const uncompressedSize = buffer.readUInt32LE(descriptorOffset + 12);
    const nextOffset = descriptorOffset + 16;

    if (
      nextOffset === buffer.length ||
      looksLikeLocalHeader(buffer, nextOffset) ||
      buffer.indexOf(ENCRYPTED_TAIL_MARKER_BUFFER, nextOffset) !== -1
    ) {
      return { descriptorOffset, compressedSize, crc32, uncompressedSize };
    }

    cursor = descriptorOffset + 1;
  }

  throw new Error(`Could not find data descriptor after offset ${dataStart}`);
}

function parseEncryptedTailInfo(buffer: Buffer): {
  hasEncryptedTailMarker: boolean;
  encryptedTailStart?: number;
  markerOffset?: number;
} {
  const markerOffset = buffer.lastIndexOf(ENCRYPTED_TAIL_MARKER_BUFFER);
  if (markerOffset === -1) {
    return { hasEncryptedTailMarker: false };
  }

  const digitsStart = markerOffset + ENCRYPTED_TAIL_MARKER_BUFFER.length;
  const digitsRaw = buffer.toString("ascii", digitsStart).trim();
  const match = digitsRaw.match(/^(\d+)/);
  if (!match) {
    return { hasEncryptedTailMarker: true, markerOffset };
  }

  const encryptedTailStart = Number(match[1]);
  if (!Number.isFinite(encryptedTailStart)) {
    return { hasEncryptedTailMarker: true, markerOffset };
  }

  return { hasEncryptedTailMarker: true, markerOffset, encryptedTailStart };
}

export function parseCustomArchive(buffer: Buffer): ParsedArchive {
  const entries: ArchiveEntryIndex[] = [];
  let offset = 0;

  while (offset + 30 <= buffer.length) {
    const version = buffer.readUInt16LE(offset + 4);
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const crc32FromHeader = buffer.readUInt32LE(offset + 14);
    const compressedSizeFromHeader = buffer.readUInt32LE(offset + 18);
    const uncompressedSizeFromHeader = buffer.readUInt32LE(offset + 22);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraFieldLength = buffer.readUInt16LE(offset + 28);

    if (version < 10 || version > 63 || fileNameLength <= 0 || fileNameLength > 4096) {
      break;
    }

    const fileNameStart = offset + 30;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd > buffer.length) {
      break;
    }

    const fileName = buffer.toString("utf8", fileNameStart, fileNameEnd);
    if (!fileName || containsControlCharacters(fileName)) {
      break;
    }

    const dataStart = fileNameEnd + extraFieldLength;
    if (dataStart > buffer.length) {
      break;
    }

    let crc32 = crc32FromHeader;
    let compressedSize = compressedSizeFromHeader;
    let uncompressedSize = uncompressedSizeFromHeader;
    let nextOffset: number;

    if ((flags & 0x08) !== 0) {
      const descriptor = findDataDescriptorOffset(buffer, dataStart);
      crc32 = descriptor.crc32;
      compressedSize = descriptor.compressedSize;
      uncompressedSize = descriptor.uncompressedSize;
      nextOffset = descriptor.descriptorOffset + 16;
    } else {
      nextOffset = dataStart + compressedSize;
    }

    if (nextOffset > buffer.length || compressedSize < 0) {
      break;
    }

    entries.push({
      name: fileName,
      method,
      flags,
      crc32,
      compressedSize,
      uncompressedSize,
      dataStart,
      isDirectory: fileName.endsWith("/"),
    });

    offset = nextOffset;
  }

  const tailInfo = parseEncryptedTailInfo(buffer);
  return {
    entries,
    stoppedAt: offset,
    hasEncryptedTailMarker: tailInfo.hasEncryptedTailMarker,
    encryptedTailStart: tailInfo.encryptedTailStart,
    markerOffset: tailInfo.markerOffset,
  };
}

export function extractEntryBuffer(buffer: Buffer, entry: ArchiveEntryIndex): Buffer {
  const compressedEnd = entry.dataStart + entry.compressedSize;
  const payload = buffer.subarray(entry.dataStart, compressedEnd);

  if (entry.method === 0) {
    return Buffer.from(payload);
  }
  if (entry.method === 8) {
    return inflateRawSync(payload);
  }

  throw new Error(`Unsupported compression method ${entry.method} for entry ${entry.name}`);
}

export function entryToUtf8(buffer: Buffer, entry: ArchiveEntryIndex): string {
  return extractEntryBuffer(buffer, entry).toString("utf8");
}

export function normalizeArchiveRelativePath(entryName: string): string {
  const normalized = entryName.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    throw new Error(`Unsafe archive path: ${entryName}`);
  }
  return normalized;
}
