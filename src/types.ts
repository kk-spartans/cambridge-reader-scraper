export type CliArgs = {
  _: string[];
  [key: string]: string | string[] | boolean;
};

export type ArchiveEntryIndex = {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  dataStart: number;
  isDirectory: boolean;
};

export type ParsedArchive = {
  entries: ArchiveEntryIndex[];
  stoppedAt: number;
  hasEncryptedTailMarker: boolean;
  encryptedTailStart?: number;
  markerOffset?: number;
};

export type ChapterNode = {
  title: string;
  href: string;
  pageIndex?: number;
  children: ChapterNode[];
};

export type BookMetadata = {
  title: string;
  isbn: string;
  opfPath: string;
  pagePaths: string[];
  tocPath?: string;
  navPath?: string;
};

export type BookInfo = {
  blobPath: string;
  blobName: string;
  title: string;
  isbn: string;
  pagePaths: string[];
  opfPath: string;
  tocPath?: string;
  navPath?: string;
  viewport: {
    width: number;
    height: number;
  };
  entryCount: number;
  hasEncryptedTailMarker: boolean;
};

export type RenderProgress = {
  completedPages: number;
  totalPages: number;
  status: "extracting" | "rendering" | "done";
  message?: string;
};

export type BookRunResult = {
  isbn: string;
  title: string;
  outputPdfPath: string;
};

export type BookRunFailure = {
  isbn: string;
  title: string;
  error: string;
};

export type UiBook = {
  isbn: string;
  title: string;
  pageCount: number;
  viewportWidth: number;
  viewportHeight: number;
  entryCount: number;
  blobName: string;
};

export type ProgressStatus = "queued" | "extracting" | "rendering" | "processing" | "done" | "error";

export type ProgressUpdate = {
  isbn: string;
  title: string;
  status: ProgressStatus;
  completedPages: number;
  totalPages: number;
  message?: string;
};

export type ReconstructionFailure = {
  isbn: string;
  title: string;
  error: string;
};

export type ReconstructionSummary = {
  succeeded: string[];
  failed: ReconstructionFailure[];
};
