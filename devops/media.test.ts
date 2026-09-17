import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

import { PDFDocument } from "pdf-lib";
import { chromium, type Browser, type BrowserContext, type Frame } from "playwright-core";

import { parseBookFromOpf } from "../src/book.js";
import { renderRemoteBookToPdf, runReconstruction } from "../src/reconstruct.js";
import type { BookInfo } from "../src/types.js";

const remoteBookBaseUrl = "https://reader.invalid/extracted_books/id/";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);
const media = new Map([
  ["OEBPS/audio/manifest-only", Buffer.from([0, 255, 1, 128])],
  ["OEBPS/audio/inline-mime", Buffer.from([2, 254, 0, 127])],
  ["OEBPS/video/lesson.unusual", Buffer.from([3, 253, 128, 0])],
  ["OEBPS/audio/lesson.mp3", Buffer.from([4, 252, 0, 129])],
  ["OEBPS/audio/inline-only.mp3", Buffer.from([5, 251, 130, 0])],
  ["OEBPS/audio/encoded lesson", Buffer.from([6, 250, 0, 131])],
]);
const mediaHrefs = new Map([...media.keys()].map((name) => [name, name]));
mediaHrefs.set("OEBPS/audio/encoded lesson", "OEBPS/audio/encoded%20lesson?revision=2");
const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" unique-identifier="isbn">
  <metadata><dc:title>Media regression</dc:title><dc:identifier id="isbn">9781234567890</dc:identifier></metadata>
  <manifest>
    <item id="page1" href="pages/one.xhtml" media-type="application/xhtml+xml"/>
    <item id="page2" href="pages/two.xhtml" media-type="application/xhtml+xml"/>
    <item id="manifest-audio" href="audio/manifest-only" media-type="audio/mpeg"/>
    <item id="inline-audio" href="audio/inline-mime" media-type="audio/ogg"/>
    <item id="video" href="video/lesson.unusual" media-type="video/mp4"/>
    <item id="mp3" href="audio/lesson.mp3" media-type="audio/mpeg"/>
    <item id="mp3-duplicate" href="audio/lesson.mp3" media-type="audio/mpeg"/>
    <item id="css" href="styles/page.css" media-type="text/css"/>
    <item id="image" href="images/page.png" media-type="image/png"/>
    <item id="notes" href="notes.txt" media-type="text/plain"/>
    <item id="encoded" href="audio/encoded%20lesson?revision=2" media-type="audio/mpeg"/>
  </manifest>
  <spine><itemref idref="page1"/><itemref idref="page2"/></spine>
</package>`;

type Branch = "image-backed" | "normal";
type Failure = "render" | "materialize";

async function withFixture(
  branch: Branch,
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  failure?: Failure,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "media-regression-"));
  try {
    await run(await createFixture(root, branch, failure));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function createFixture(root: string, branch: Branch, failure?: Failure) {
  const book: BookInfo = {
    ...parseBookFromOpf(opf, "OEBPS/content.opf"),
    blobPath: path.join(root, "unused.blob"),
    blobName: "unused.blob",
    viewport: { width: 32, height: 48 },
    entryCount: 12,
    hasEncryptedTailMarker: false,
  };
  assert.deepEqual(
    book.mediaPaths,
    [...mediaHrefs.values()].filter((name) => !name.endsWith("inline-only.mp3")),
  );
  if (failure === "render") {
    book.pagePaths = book.pagePaths.slice(0, 1);
  }
  const xhtml = Buffer.from(`<html><head><link href="../styles/page.css" rel="stylesheet"/></head>
<body><audio src="../audio/lesson.mp3"></audio><audio src="../audio/lesson.mp3#t=1"></audio>
<audio src="../audio/inline-only.mp3"></audio><audio src="../audio/inline-only.mp3#t=2"></audio>
<audio src="../audio/inline-mime"></audio>
<audio src="../audio/encoded%20lesson?revision=2"></audio>
<audio src="../audio/encoded%20lesson?revision=2#t=3"></audio>
<video src="../video/lesson.unusual"></video><a href="../notes.txt">Notes</a></body></html>`);
  const assets = new Map<string, Buffer>(
    [
      ...media,
      ["OEBPS/pages/one.xhtml", xhtml],
      ["OEBPS/pages/two.xhtml", xhtml],
      [
        "OEBPS/styles/page.css",
        Buffer.from(
          branch === "image-backed"
            ? 'body { background-image: url("../images/page.png"); }'
            : "body { color: black; }",
        ),
      ],
      ["OEBPS/images/page.png", failure === "render" ? Buffer.from("invalid PNG") : png],
      ["OEBPS/notes.txt", Buffer.from("Not supplementary media")],
    ].map(([name, bytes]) => [
      new URL(mediaHrefs.get(name as string) ?? (name as string), remoteBookBaseUrl).href,
      bytes as Buffer,
    ]),
  );
  if (failure === "materialize") {
    assets.delete(new URL("OEBPS/images/page.png", remoteBookBaseUrl).href);
  }
  const requests: string[] = [];
  const fallbackRequests: string[] = [];
  const pageCalls = { opened: 0, closed: 0, printed: 0, navigated: 0, evaluated: 0, emulated: 0 };
  const context = {
    cookies: async () => [],
    request: {
      get: async (url: string) => {
        requests.push(url);
        const body = assets.get(url);
        return {
          ok: () => body !== undefined,
          status: () => (body === undefined ? 404 : 200),
          body: async () => {
            assert.ok(body, `Unexpected asset request: ${url}`);
            return body;
          },
        };
      },
    },
    newPage: async () => {
      assert.equal(branch, "normal", "Image-backed rendering must not open a browser page");
      pageCalls.opened += 1;
      return {
        setDefaultNavigationTimeout: (timeout: number) => assert.equal(timeout, 1000),
        goto: async (url: string) => {
          const parsed = new URL(url);
          assert.equal(parsed.protocol, "http:");
          assert.ok(Number(parsed.port) > 0, "Normal rendering uses the ephemeral asset server");
          assert.ok(book.pagePaths.some((name) => parsed.pathname.endsWith(name)));
          pageCalls.navigated += 1;
          return { status: () => 200 };
        },
        evaluate: async () => {
          pageCalls.evaluated += 1;
          return undefined;
        },
        emulateMedia: async (options: { media: string }) => {
          assert.equal(options.media, "print");
          pageCalls.emulated += 1;
        },
        pdf: async (options: { path: string }) => {
          const pdf = await PDFDocument.create();
          pdf.addPage([book.viewport.width, book.viewport.height]);
          const bytes = await pdf.save();
          await fs.writeFile(options.path, bytes);
          pageCalls.printed += 1;
          if (failure === "render") {
            throw new Error("Injected PDF failure");
          }
          return Buffer.from(bytes);
        },
        close: async () => {
          pageCalls.closed += 1;
        },
      };
    },
  } as unknown as BrowserContext;
  const viewerFrame = {
    url: () => new URL("viewer.html", remoteBookBaseUrl).href,
    page: () => ({ context: () => context }),
    evaluate: async (_callback: unknown, url?: string) => {
      if (url !== undefined) {
        fallbackRequests.push(url);
        throw new Error(`No browser/network fallback allowed: ${url}`);
      }
      return "media-regression-test";
    },
  } as unknown as Frame;
  const tempRoot = path.join(root, "temporary");
  const outputPdfPath = path.join(root, "output", "book.pdf");
  const mediaOutDir = path.join(root, "output", "book_media");
  await fs.mkdir(tempRoot);
  return {
    book,
    context,
    viewerFrame,
    requests,
    fallbackRequests,
    pageCalls,
    tempRoot,
    outputPdfPath,
    mediaOutDir,
    render: (skipMedia = false) =>
      renderRemoteBookToPdf({
        remoteBookBaseUrl,
        book,
        context,
        viewerFrame,
        outputPdfPath,
        navigationTimeoutMs: 1000,
        tempRoot,
        skipMedia,
      }),
  };
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = entry.name;
      return entry.isDirectory()
        ? (await filesUnder(path.join(root, relative))).map((name) =>
            path.posix.join(relative, name),
          )
        : [relative];
    }),
  );
  return nested.flat().sort();
}

for (const branch of ["image-backed", "normal"] as const) {
  await test(`${branch}: copy supplementary media through public renderer`, async (t) => {
    await withFixture(branch, async (fixture) => {
      const result = await fixture.render();
      const actual = await filesUnder(fixture.mediaOutDir);
      await t.test("renders a valid PDF using only the expected branch", async () => {
        const pdf = await PDFDocument.load(await fs.readFile(fixture.outputPdfPath));
        assert.equal(pdf.getPageCount(), 2);
        assert.equal(pdf.getTitle(), fixture.book.title);
        assert.equal(fixture.pageCalls.opened, branch === "normal" ? 2 : 0);
        assert.equal(fixture.pageCalls.closed, fixture.pageCalls.opened);
        assert.equal(fixture.pageCalls.printed, fixture.pageCalls.opened);
        assert.equal(fixture.pageCalls.navigated, fixture.pageCalls.opened);
        assert.equal(fixture.pageCalls.emulated, fixture.pageCalls.opened);
        assert.equal(fixture.pageCalls.evaluated, fixture.pageCalls.opened * 2);
        assert.deepEqual(fixture.fallbackRequests, []);
      });
      await t.test("copies MIME-only audio and odd-extension video with exact bytes", async () => {
        for (const [name, bytes] of media) {
          const saved = actual.find((file) => file.endsWith(name));
          assert.ok(saved, `Missing media: ${name}`);
          assert.deepEqual(await fs.readFile(path.join(fixture.mediaOutDir, saved)), bytes, name);
        }
      });
      await t.test("preserves OEBPS paths without extracted_books/id prefix", () => {
        assert.deepEqual(actual, [...media.keys()].sort());
        assert.deepEqual(
          result.mediaFiles
            .map((file) => path.relative(fixture.mediaOutDir, file).split(path.sep).join("/"))
            .sort(),
          actual,
        );
      });
      await t.test("does not duplicate manifest or inline media requests or output", () => {
        for (const name of media.keys()) {
          const url = new URL(mediaHrefs.get(name) ?? name, remoteBookBaseUrl).href;
          assert.equal(fixture.requests.filter((requested) => requested === url).length, 1, name);
        }
        assert.equal(new Set(result.mediaFiles).size, result.mediaFiles.length);
        assert.equal(result.mediaFiles.length, media.size);
      });
      await t.test("does not copy non-media assets", () => {
        assert.ok(fixture.requests.includes(new URL("OEBPS/notes.txt", remoteBookBaseUrl).href));
        assert.ok(actual.every((file) => [...media.keys()].some((name) => file.endsWith(name))));
      });
      await t.test("cleans temporary assets and page PDFs after success", async () => {
        assert.deepEqual(await fs.readdir(fixture.tempRoot), []);
      });
    });
  });

  await test(`${branch}: skipMedia suppresses downloads, not just output`, async (t) => {
    await withFixture(branch, async (fixture) => {
      const result = await fixture.render(true);
      await t.test("still renders without media output", async () => {
        assert.equal(
          (await PDFDocument.load(await fs.readFile(fixture.outputPdfPath))).getPageCount(),
          2,
        );
        assert.deepEqual(result.mediaFiles, []);
        assert.deepEqual(await filesUnder(fixture.mediaOutDir), []);
      });
      for (const name of media.keys()) {
        await t.test(`does not request ${name}`, () => {
          const url = new URL(mediaHrefs.get(name) ?? name, remoteBookBaseUrl).href;
          assert.ok(!fixture.requests.includes(url), `skipMedia requested ${name}`);
          assert.ok(!fixture.fallbackRequests.includes(url));
        });
      }
      await t.test("cleans temporary assets with skipMedia", async () => {
        assert.deepEqual(await fs.readdir(fixture.tempRoot), []);
      });
    });
  });

  await test(`${branch}: cleans temporary assets and partial PDFs after render failure`, async () => {
    await withFixture(
      branch,
      async (fixture) => {
        await assert.rejects(
          fixture.render(),
          branch === "normal" ? /Injected PDF failure/ : /PNG/i,
        );
        assert.equal(fixture.pageCalls.closed, fixture.pageCalls.opened);
        assert.deepEqual(await fs.readdir(fixture.tempRoot), []);
      },
      "render",
    );
  });
}

await test("cleans partially materialized assets when downloading fails before rendering", async () => {
  await withFixture(
    "image-backed",
    async (fixture) => {
      await assert.rejects(fixture.render(), /Unable to fetch .*images\/page\.png/);
      assert.equal(fixture.pageCalls.opened, 0);
      assert.deepEqual(await fs.readdir(fixture.tempRoot), []);
    },
    "materialize",
  );
});

await test("download failure waits for a delayed writer before cleaning assets", async (t) => {
  await withFixture("image-backed", async (fixture) => {
    fixture.book.pagePaths = ["OEBPS/pages/one.xhtml"];
    fixture.book.mediaPaths = ["OEBPS/audio/manifest-only"];
    const writerStarted = Promise.withResolvers<void>();
    const releaseWriter = Promise.withResolvers<void>();
    const writerFinished = Promise.withResolvers<void>();
    const downloadFailed = Promise.withResolvers<void>();
    const events: string[] = [];
    const assetRoot = path.join(fixture.tempRoot, `${fixture.book.isbn}_remote_assets`);
    const originalWrite = fs.writeFile;
    const originalRm = fs.rm;
    const originalGet = fixture.context.request.get.bind(fixture.context.request);
    const writeMock = t.mock.method(
      fs,
      "writeFile",
      async (...args: Parameters<typeof fs.writeFile>) => {
        if (typeof args[0] === "string" && args[0].endsWith(path.join("pages", "one.xhtml"))) {
          events.push("writer-started");
          writerStarted.resolve();
          await releaseWriter.promise;
          try {
            await originalWrite(...args);
            events.push("writer-finished");
          } finally {
            writerFinished.resolve();
          }
        } else {
          await originalWrite(...args);
        }
      },
    );
    const rmMock = t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === assetRoot && events.includes("download-failed")) {
        events.push("cleanup");
      }
      await originalRm(...args);
    });
    t.mock.method(
      fixture.context.request,
      "get",
      async (...[url, options]: Parameters<typeof originalGet>) => {
        if (url.endsWith("audio/manifest-only")) {
          await writerStarted.promise;
          throw new Error("Injected download failure");
        }
        return originalGet(url, options);
      },
    );
    t.mock.method(fixture.viewerFrame, "evaluate", async () => {
      if (events.includes("writer-started")) {
        events.push("download-failed");
        downloadFailed.resolve();
        throw new Error("Injected fallback failure");
      }
      return "media-regression-test";
    });
    const outcome = fixture.render().then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await downloadFailed.promise;
      await delay(30);
      releaseWriter.resolve();
      const error = await outcome;
      await writerFinished.promise;
      assert.ok(error instanceof Error);
      assert.match(error.message, /Injected download failure/);
      assert.deepEqual(events, ["writer-started", "download-failed", "writer-finished", "cleanup"]);
      assert.deepEqual(await fs.readdir(fixture.tempRoot), []);
      assert.equal(fixture.pageCalls.opened, 0);
    } finally {
      releaseWriter.resolve();
      await outcome;
      await writerFinished.promise;
      writeMock.mock.restore();
      rmMock.mock.restore();
    }
  });
});

function customArchive(entries: Map<string, Buffer>): Buffer {
  return Buffer.concat(
    [...entries].flatMap(([name, bytes]) => {
      const filename = Buffer.from(name);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt32LE(crc32(bytes), 14);
      header.writeUInt32LE(bytes.length, 18);
      header.writeUInt32LE(bytes.length, 22);
      header.writeUInt16LE(filename.length, 26);
      return [header, filename, bytes];
    }),
  );
}

for (const skipMedia of [false, true]) {
  await test(`local archive: MIME-only media and skipMedia=${skipMedia}`, async (t) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "media-local-regression-"));
    try {
      const localOpf = opf.replace("audio/encoded%20lesson?revision=2", "audio/encoded-lesson");
      const localMedia = new Map(
        [...media].map(([name, bytes]) => [
          name.replace("encoded lesson", "encoded-lesson"),
          bytes,
        ]),
      );
      const pageBytes = Buffer.from("<html><body>Local archive page</body></html>");
      const entries = new Map([
        ...localMedia,
        ["OEBPS/content.opf", Buffer.from(localOpf)],
        ["OEBPS/pages/one.xhtml", pageBytes],
        ["OEBPS/pages/two.xhtml", pageBytes],
        ["OEBPS/notes.txt", Buffer.from("Not supplementary media")],
      ]);
      const book: BookInfo = {
        ...parseBookFromOpf(localOpf, "OEBPS/content.opf"),
        blobPath: path.join(root, "book.blob"),
        blobName: "book.blob",
        viewport: { width: 32, height: 48 },
        entryCount: entries.size,
        hasEncryptedTailMarker: false,
      };
      await fs.writeFile(book.blobPath, customArchive(entries));
      const calls = { printed: 0, pageClosed: 0, contextClosed: 0, browserClosed: 0 };
      const page = {
        setDefaultNavigationTimeout: (timeout: number) => assert.equal(timeout, 1000),
        goto: async (url: string) => {
          assert.deepEqual(await fs.readFile(fileURLToPath(url)), pageBytes);
        },
        evaluate: async () => undefined,
        emulateMedia: async (options: { media: string }) => assert.equal(options.media, "print"),
        pdf: async (options: { path: string }) => {
          const pdf = await PDFDocument.create();
          pdf.addPage([book.viewport.width, book.viewport.height]);
          const bytes = Buffer.from(await pdf.save());
          await fs.writeFile(options.path, bytes);
          calls.printed += 1;
          return bytes;
        },
        close: async () => {
          calls.pageClosed += 1;
        },
      };
      const browser = {
        newContext: async () => ({
          newPage: async () => page,
          close: async () => {
            calls.contextClosed += 1;
          },
        }),
        close: async () => {
          calls.browserClosed += 1;
        },
      } as unknown as Browser;
      const launch = t.mock.method(chromium, "launch", async () => browser);
      const tempRoot = path.join(root, "temporary");
      const outDir = path.join(root, "output");
      const result = await runReconstruction({
        books: [book],
        outDir,
        tempRoot,
        browserPath: "unused-fake-chromium",
        navigationTimeoutMs: 1000,
        keepExtracted: false,
        concurrency: 1,
        skipMedia,
        emit: () => {},
      });
      assert.deepEqual(result.failed, []);
      assert.equal(result.succeeded.length, 1);
      const outputPdfPath = result.succeeded[0];
      assert.ok(outputPdfPath);
      assert.equal((await PDFDocument.load(await fs.readFile(outputPdfPath))).getPageCount(), 2);
      assert.equal(launch.mock.callCount(), 1);
      assert.deepEqual(calls, { printed: 2, pageClosed: 1, contextClosed: 1, browserClosed: 1 });
      const mediaDir = path.join(outDir, `${path.basename(outputPdfPath, ".pdf")}_media`);
      const expected = skipMedia ? [] : [...localMedia.keys()].sort();
      assert.deepEqual(await filesUnder(mediaDir), expected);
      assert.deepEqual(
        result.mediaFiles
          .map((file) => path.relative(mediaDir, file).split(path.sep).join("/"))
          .sort(),
        expected,
      );
      for (const name of expected) {
        assert.deepEqual(await fs.readFile(path.join(mediaDir, name)), localMedia.get(name));
      }
      assert.deepEqual(await fs.readdir(tempRoot), []);
    } finally {
      t.mock.restoreAll();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
