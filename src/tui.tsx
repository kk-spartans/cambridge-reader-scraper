import { setTimeout as delay } from "node:timers/promises";

import { Box, Text, render, useInput, useStdout } from "ink";
import React, { useEffect, useMemo, useState } from "react";

import type { ProgressStatus, ProgressUpdate, ReconstructionSummary, UiBook } from "./types.js";

type BookSelectionProps = {
  books: UiBook[];
  onSubmit: (selectedIsbns: string[]) => void;
  onCancel: () => void;
};

type ProgressScreenProps = {
  books: UiBook[];
  run: (emit: (update: ProgressUpdate) => void) => Promise<ReconstructionSummary>;
  onFinish: (result: ReconstructionSummary) => void;
  onError: (error: unknown) => void;
  onCancel: () => void;
};

type OutputDirectoryPromptProps = {
  defaultValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
};

function hardCancelProcess(): never {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(false);
  }

  process.stdout.write("\x1B[?25h");
  process.exit(130);
}

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 3) {
    return value.slice(0, Math.max(0, maxLength));
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function progressBar(completed: number, total: number, width: number): string {
  const safeTotal = total <= 0 ? 1 : total;
  const ratio = clamp(completed / safeTotal, 0, 1);
  const filled = Math.round(ratio * width);
  const empty = Math.max(0, width - filled);
  return `[${"=".repeat(filled)}${" ".repeat(empty)}]`;
}

function statusColor(status: ProgressStatus): string {
  switch (status) {
    case "done":
      return "green";
    case "error":
      return "red";
    case "rendering":
      return "cyan";
    case "extracting":
      return "yellow";
    case "processing":
      return "magenta";
    default:
      return "gray";
  }
}

function statusLabel(status: ProgressStatus): string {
  switch (status) {
    case "queued":
      return "queued";
    case "extracting":
      return "extract";
    case "rendering":
      return "render";
    case "processing":
      return "process";
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return "unknown";
  }
}

function OutputDirectoryPrompt({
  defaultValue,
  onSubmit,
  onCancel,
}: OutputDirectoryPromptProps): React.JSX.Element {
  const [value, setValue] = useState(defaultValue);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      hardCancelProcess();
    }

    if (key.return) {
      onSubmit(value.trim() || defaultValue);
      return;
    }

    if (key.escape) {
      setValue(defaultValue);
      return;
    }

    if (key.backspace || key.delete) {
      setValue((current: string) => current.slice(0, -1));
      return;
    }

    if (!key.ctrl && !key.meta && input.length === 1 && input >= " " && input <= "~") {
      setValue((current: string) => `${current}${input}`);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyan">Choose output directory</Text>
      <Text color="gray">Enter = confirm, Esc = reset, Ctrl+C = cancel</Text>
      <Text>
        Output dir: <Text color="yellow">{value || "(empty)"}</Text>
      </Text>
    </Box>
  );
}

function BookSelection({ books, onSubmit, onCancel }: BookSelectionProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const { stdout } = useStdout();
  const columns = stdout.columns || 120;
  const rows = stdout.rows || 36;

  const filteredBooks = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) {
      return books;
    }

    return books.filter((book) => {
      const haystack = `${book.isbn} ${book.title}`.toLowerCase();
      return haystack.includes(search);
    });
  }, [books, query]);

  useEffect(() => {
    if (!filteredBooks.length) {
      if (cursor !== 0) {
        setCursor(0);
      }
      return;
    }

    if (cursor >= filteredBooks.length) {
      setCursor(filteredBooks.length - 1);
    }
  }, [cursor, filteredBooks]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      hardCancelProcess();
    }

    if (key.upArrow) {
      setCursor((value: number) => Math.max(0, value - 1));
      return;
    }

    if (key.downArrow) {
      setCursor((value: number) => {
        const maxIndex = Math.max(0, filteredBooks.length - 1);
        return Math.min(maxIndex, value + 1);
      });
      return;
    }

    if (key.return) {
      if (!books.length) {
        onCancel();
        return;
      }

      if (selected.size > 0) {
        onSubmit(Array.from(selected));
        return;
      }

      const highlighted = filteredBooks[cursor];
      if (highlighted) {
        onSubmit([highlighted.isbn]);
      }
      return;
    }

    if (key.escape) {
      if (query.length > 0) {
        setQuery("");
      }
      return;
    }

    if (key.backspace || key.delete) {
      setQuery((value: string) => value.slice(0, -1));
      return;
    }

    if (input === " ") {
      const highlighted = filteredBooks[cursor];
      if (!highlighted) {
        return;
      }

      setSelected((current: Set<string>) => {
        const next = new Set(current);
        if (next.has(highlighted.isbn)) {
          next.delete(highlighted.isbn);
        } else {
          next.add(highlighted.isbn);
        }
        return next;
      });
      return;
    }

    if (!key.ctrl && !key.meta && input.length === 1 && input >= " " && input <= "~") {
      setQuery((value: string) => `${value}${input}`);
    }
  });

  const highlighted = filteredBooks[cursor];
  const listHeight = Math.max(8, rows - 13);
  const startIndex = clamp(
    cursor - Math.floor(listHeight / 2),
    0,
    Math.max(0, filteredBooks.length - listHeight),
  );
  const visibleBooks = filteredBooks.slice(startIndex, startIndex + listHeight);

  const listWidth = Math.max(44, Math.floor(columns * 0.6));
  const detailsWidth = Math.max(30, columns - listWidth - 6);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyan">Cambridge Reader Scraper</Text>
      <Text>
        Search: <Text color="yellow">{query || "(all books)"}</Text>
      </Text>

      <Box marginTop={1}>
        <Box flexDirection="column" width={listWidth} marginRight={2}>
          <Text color="green">Books ({filteredBooks.length})</Text>
          {visibleBooks.length ? (
            visibleBooks.map((book: UiBook, index: number) => {
              const absoluteIndex = startIndex + index;
              const isActive = absoluteIndex === cursor;
              const isSelected = selected.has(book.isbn);
              const marker = isActive ? ">" : " ";
              const selectedMarker = isSelected ? "[x]" : "[ ]";
              const titleWidth = Math.max(12, listWidth - 28);
              return (
                <React.Fragment key={book.isbn}>
                  <Text color={isActive ? "cyan" : "white"}>
                    {marker} {selectedMarker} {truncate(book.title, titleWidth)}
                  </Text>
                </React.Fragment>
              );
            })
          ) : (
            <Text color="yellow">No matches.</Text>
          )}
        </Box>

        <Box flexDirection="column" width={detailsWidth}>
          <Text color="green">Details</Text>
          {highlighted ? (
            <>
              <Text>{truncate(highlighted.title, detailsWidth)}</Text>
              <Text color="gray">ISBN: {highlighted.isbn}</Text>
              <Text color="gray">Pages: {highlighted.pageCount}</Text>
              <Text color="gray">
                Viewport: {highlighted.viewportWidth}x{highlighted.viewportHeight}
              </Text>
              <Text color="gray">Archive entries: {highlighted.entryCount}</Text>
              <Text color="gray">Blob: {highlighted.blobName}</Text>
            </>
          ) : (
            <Text color="yellow">Select a book to view details.</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function ProgressScreen({
  books,
  run,
  onFinish,
  onError,
  onCancel,
}: ProgressScreenProps): React.JSX.Element {
  const [updates, setUpdates] = useState<Record<string, ProgressUpdate>>(() => {
    const seeded: Record<string, ProgressUpdate> = {};
    for (const book of books) {
      seeded[book.isbn] = {
        isbn: book.isbn,
        title: book.title,
        status: "queued",
        completedPages: 0,
        totalPages: book.pageCount,
      };
    }
    return seeded;
  });

  useEffect(() => {
    let isActive = true;

    void run((update) => {
      if (!isActive) {
        return;
      }

      setUpdates((current: Record<string, ProgressUpdate>) => {
        const previous = current[update.isbn];
        if (!previous) {
          return current;
        }

        return {
          ...current,
          [update.isbn]: {
            ...previous,
            ...update,
            completedPages: Math.max(previous.completedPages, update.completedPages),
          },
        };
      });
    })
      .then(async (result) => {
        if (!isActive) {
          return;
        }

        await delay(150);
        if (isActive) {
          onFinish(result);
        }
      })
      .catch((error) => {
        if (isActive) {
          onError(error);
        }
      });

    return () => {
      isActive = false;
    };
  }, [onError, onFinish, run]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      hardCancelProcess();
    }
  });

  const { stdout } = useStdout();
  const columns = stdout.columns || 120;
  const barWidth = clamp(Math.floor(columns * 0.24), 16, 34);

  const allUpdates = books.map((book) => updates[book.isbn]).filter(Boolean);
  const doneCount = allUpdates.filter((item) => item?.status === "done").length;
  const errorCount = allUpdates.filter((item) => item?.status === "error").length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyan">Reconstruction in progress</Text>
      <Text color="gray">
        Books done: {doneCount}/{books.length} errors: {errorCount}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {allUpdates.map((item) => {
          const update = item as ProgressUpdate;
          const label = truncate(update.title, clamp(columns - barWidth - 28, 16, 70));
          const meta = `${update.completedPages}/${update.totalPages}`;
          return (
            <React.Fragment key={update.isbn}>
              <Text color={statusColor(update.status)}>
                {statusLabel(update.status).padEnd(7, " ")}{" "}
                {progressBar(update.completedPages, update.totalPages, barWidth)}{" "}
                {meta.padEnd(12, " ")} {label}
              </Text>
            </React.Fragment>
          );
        })}
      </Box>
    </Box>
  );
}

export async function promptOutputDirectoryWithInk(defaultValue: string): Promise<string> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    return defaultValue;
  }

  return new Promise((resolve, reject) => {
    let instance: ReturnType<typeof render> | undefined;

    const submit = (value: string) => {
      if (instance) {
        instance.unmount();
      }
      resolve(value);
    };

    const cancel = () => {
      if (instance) {
        instance.unmount();
      }
      reject(new Error("Cancelled by user."));
    };

    instance = render(<OutputDirectoryPrompt defaultValue={defaultValue} onSubmit={submit} onCancel={cancel} />, {
      exitOnCtrlC: false,
    });
  });
}

export async function selectBooksWithInk(books: UiBook[]): Promise<string[]> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    return books.map((book) => book.isbn);
  }

  return new Promise((resolve) => {
    let instance: ReturnType<typeof render> | undefined;

    const finalize = (selectedIsbns: string[]) => {
      if (instance) {
        instance.unmount();
      }
      resolve(selectedIsbns);
    };

    instance = render(
      <BookSelection books={books} onSubmit={finalize} onCancel={() => finalize([])} />,
      {
        exitOnCtrlC: false,
      },
    );
  });
}

export async function runWithInkProgress(params: {
  books: UiBook[];
  run: (emit: (update: ProgressUpdate) => void) => Promise<ReconstructionSummary>;
}): Promise<ReconstructionSummary> {
  const { books, run } = params;

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    return run(() => {});
  }

  return new Promise((resolve, reject) => {
    let instance: ReturnType<typeof render> | undefined;

    const finish = (result: ReconstructionSummary) => {
      if (instance) {
        instance.unmount();
      }
      resolve(result);
    };

    const fail = (error: unknown) => {
      if (instance) {
        instance.unmount();
      }
      reject(error);
    };

    const cancel = () => {
      if (instance) {
        instance.unmount();
      }
      reject(new Error("Cancelled by user."));
    };

    instance = render(
      <ProgressScreen books={books} run={run} onFinish={finish} onError={fail} onCancel={cancel} />,
      {
        exitOnCtrlC: false,
      },
    );
  });
}
