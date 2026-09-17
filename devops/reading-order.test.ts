import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { crc32 } from "node:zlib";

import { PDFDocument } from "pdf-lib";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import { normalizePrintReadingOrder } from "../src/reading-order.js";
import {
  detectPlaywrightBrowserExecutable,
  renderRemoteBookToPdf,
  runReconstruction,
} from "../src/reconstruct.js";
import type { BookInfo } from "../src/types.js";

const viewport = { width: 800, height: 600 };
const image =
  '<img id="art" alt="fixture" width="16" height="16" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">';
let browser: Browser;
let executablePath: string;

before(async () => {
  try {
    executablePath = process.env.CHROMIUM_PATH || detectPlaywrightBrowserExecutable();
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (cause) {
    throw new Error(
      "Browser regression tests require working Chromium. Install Chromium or set CHROMIUM_PATH to its executable, then run pnpm run test:browser.",
      { cause },
    );
  }
});

after(async () => {
  await browser?.close();
});

function fixture(content: string, css = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; }
    #sheet { position: relative; width: 700px; height: 500px; }
    .line { position: absolute; left: 20px; width: 320px; height: 24px;
      margin: 0; padding: 0; border: 0; font: 16px/24px monospace;
      color: black; white-space: normal; }
    ${css}
  </style></head><body><div id="sheet">${content}</div></body></html>`;
}

function line(id: string, top: number, text: string, style = "", tag = "div"): string {
  return `<${tag} id="${id}" class="line" style="top:${top}px;${style}">${text}</${tag}>`;
}

async function openFixture(t: TestContext, html: string): Promise<Page> {
  const context = await browser.newContext({ viewport });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.emulateMedia({ media: "print" });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return page;
}

async function snapshot(page: Page) {
  return page.locator("#sheet").evaluate((sheet) => ({
    html: sheet.innerHTML,
    children: Array.from(sheet.children, (child) => {
      const rect = child.getBoundingClientRect();
      return {
        id: child.id,
        text: child.textContent,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }),
  }));
}

async function assertUnchanged(page: Page): Promise<void> {
  const original = await snapshot(page);
  const stats = await normalizePrintReadingOrder(page);
  assert.deepEqual(await snapshot(page), original);
  assert.equal(stats.mergedParagraphs, 0);
  assert.equal(stats.reorderedParents, 0);
}

void test("reversed absolute divs reorder and merge in visual reading order", async (t) => {
  const page = await openFixture(
    t,
    fixture(line("second", 64, "second line") + line("first", 40, "First line")),
  );
  assert.deepEqual(await page.locator(".line").allTextContents(), ["second line", "First line"]);
  const stats = await normalizePrintReadingOrder(page);
  assert.deepEqual(stats, { textBlocks: 2, reorderedParents: 1, mergedParagraphs: 1 });
  assert.deepEqual(await page.locator(".line").allTextContents(), ["First line second line"]);
});

void test("merging preserves the first box x/y in a nested offset containing block", async (t) => {
  const page = await openFixture(
    t,
    fixture(
      `<div style="position:relative;left:71px;top:53px;width:500px;height:300px">
        <div style="position:relative;left:29px;top:31px;width:400px;height:200px">
          ${line("second", 64, "second line")}${line("first", 40, "First line")}
        </div>
      </div>`,
      "#sheet { left: 37px; top: 19px; }",
    ),
  );
  const original = await page.locator("#first").boundingBox();
  assert.ok(original);
  assert.equal(original.x, 157);
  assert.equal(original.y, 143);
  const stats = await normalizePrintReadingOrder(page);
  assert.equal(stats.mergedParagraphs, 1);
  assert.deepEqual(await page.locator(".line").allTextContents(), ["First line second line"]);
  const merged = await page.locator(".line").boundingBox();
  assert.ok(merged);
  assert.equal(merged.x, original.x);
  assert.equal(merged.y, original.y);
});

for (const [name, descendant] of [
  ["bold", '<b id="inline">bold words</b>'],
  ["link", '<a id="inline" href="#target">linked words</a>'],
  ["image", image],
]) {
  for (const position of ["first", "second"]) {
    void test(`inline ${name} in ${position} line survives without flattening or merging`, async (t) => {
      const rich = `Text before ${descendant} text after`;
      const page = await openFixture(
        t,
        fixture(
          line("first", 40, position === "first" ? rich : "Plain first line") +
            line("second", 64, position === "second" ? rich : "Plain second line"),
        ),
      );
      await assertUnchanged(page);
      assert.equal(await page.locator(".line > *").count(), 1);
    });
  }
}

for (const [property, value] of [
  ["font-family", "serif"],
  ["color", "rgb(170, 30, 40)"],
  ["word-spacing", "4px"],
  ["opacity", "0.5"],
  ["direction", "rtl"],
  ["z-index", "1"],
]) {
  void test(`${property} mismatch prevents merging`, async (t) => {
    const page = await openFixture(
      t,
      fixture(
        line("first", 40, "First line") + line("second", 64, "second line", `${property}:${value}`),
      ),
    );
    await assertUnchanged(page);
  });
}

void test("z-index mismatch also prevents reordering reversed siblings", async (t) => {
  const page = await openFixture(
    t,
    fixture(line("second", 64, "second line", "z-index:1") + line("first", 40, "First line")),
  );
  await assertUnchanged(page);
});

for (const [name, media] of [
  ["image", image],
  ["canvas", '<canvas id="art" width="16" height="16"></canvas>'],
  ["SVG", '<svg id="art" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>'],
]) {
  for (const order of [
    "reversed with media between",
    "reversed with media last",
    "contiguous text with media last",
  ]) {
    void test(`${name} sibling prevents reordering and merging: ${order}`, async (t) => {
      const first = line("first", 40, "First line");
      const second = line("second", 64, "second line");
      const content =
        order === "reversed with media between"
          ? second + media + first
          : order === "reversed with media last"
            ? second + first + media
            : first + second + media;
      const page = await openFixture(
        t,
        fixture(content, "#art { position: absolute; left: 20px; top: 44px; }"),
      );
      await assertUnchanged(page);
    });
  }
}

void test("normal whitespace permits merging and collapses spaces", async (t) => {
  const page = await openFixture(
    t,
    fixture(line("first", 40, "First   line") + line("second", 64, "second\tline")),
  );
  assert.equal((await normalizePrintReadingOrder(page)).mergedParagraphs, 1);
  assert.deepEqual(await page.locator(".line").allTextContents(), ["First line second line"]);
});

for (const whiteSpace of ["nowrap", "break-spaces", "pre", "pre-wrap", "pre-line"]) {
  void test(`${whiteSpace} whitespace is left unchanged`, async (t) => {
    const page = await openFixture(
      t,
      fixture(
        line("first", 40, "First   line") + line("second", 64, "second\tline"),
        `.line { white-space: ${whiteSpace}; }`,
      ),
    );
    await assertUnchanged(page);
  });
}

for (const [name, first, second, expected] of [
  ["literal hyphen", "well-", "known", "well-known"],
  ["explicit soft hyphen", "inter\u00ad", "national", "international"],
]) {
  void test(`${name} joins without an inserted space`, async (t) => {
    const page = await openFixture(
      t,
      fixture(line("first", 40, first!) + line("second", 64, second!)),
    );
    assert.equal((await normalizePrintReadingOrder(page)).mergedParagraphs, 1);
    assert.deepEqual(await page.locator(".line").allTextContents(), [expected]);
  });
}

for (const gap of [24, 28]) {
  void test(`${gap}px pitch ${gap === 28 ? "splits paragraphs" : "continues a paragraph"} after full-length lines`, async (t) => {
    const texts = [
      "Alpha line has full length",
      "Bravo line has full length",
      "Charlie line is full length",
      "Delta line has full length",
    ];
    const tops = [40, 64, 64 + gap, 88 + gap];
    const page = await openFixture(
      t,
      fixture(texts.map((text, index) => line(`line-${index}`, tops[index]!, text)).join("")),
    );
    const beforeBoxes = (await snapshot(page)).children;
    assert.deepEqual(
      beforeBoxes.map((box) => box.y),
      tops,
    );
    const stats = await normalizePrintReadingOrder(page);
    assert.equal(stats.mergedParagraphs, gap === 28 ? 2 : 1);
    assert.deepEqual(
      await page.locator(".line").allTextContents(),
      gap === 28 ? [texts.slice(0, 2).join(" "), texts.slice(2).join(" ")] : [texts.join(" ")],
    );
  });
}

for (const tag of ["p", "li"]) {
  void test(`explicit separate ${tag} elements do not merge`, async (t) => {
    const content =
      line("first", 40, "First complete thought.", "", tag) +
      line("second", 64, "Another complete thought.", "", tag);
    const page = await openFixture(t, fixture(tag === "li" ? `<ul>${content}</ul>` : content));
    await assertUnchanged(page);
    assert.equal(await page.locator(tag === "li" ? "ul > li" : "#sheet > p").count(), 2);
  });
}

const printFixture = fixture(
  line("second", 40, "second line") + line("first", 140, "First line"),
  "@media print { #first { top: 40px !important; } #second { top: 64px !important; } }",
);

async function printState(page: Page) {
  return {
    print: await page.evaluate(() => matchMedia("print").matches),
    children: (await snapshot(page)).children,
  };
}

function observePdf(
  t: TestContext,
  context: BrowserContext,
  states: Awaited<ReturnType<typeof printState>>[],
): void {
  const newPage = context.newPage.bind(context);
  t.mock.method(context, "newPage", async () => {
    const page = await newPage();
    const pdf = page.pdf.bind(page);
    t.mock.method(page, "pdf", async (options: Parameters<Page["pdf"]>[0]) => {
      states.push(await printState(page));
      return pdf(options);
    });
    return page;
  });
}

function archivePage(html: string): Buffer {
  const name = Buffer.from("page.html");
  const body = Buffer.from(html);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt32LE(crc32(body), 14);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(body.length, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name, body]);
}

for (const renderPath of ["local archive", "remote context"]) {
  void test(`${renderPath} renders a real PDF using print-media geometry before normalization`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "reading-order-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const book: BookInfo = {
      blobPath: join(root, "fixture.blob"),
      blobName: "fixture.blob",
      title: "Reading order fixture",
      isbn: "fixture",
      pagePaths: ["page.html"],
      mediaPaths: [],
      opfPath: "content.opf",
      viewport,
      entryCount: 1,
      hasEncryptedTailMarker: false,
    };
    const states: Awaited<ReturnType<typeof printState>>[] = [];
    let output: string;

    if (renderPath === "local archive") {
      await writeFile(book.blobPath, archivePage(printFixture));
      const launch = chromium.launch.bind(chromium);
      t.mock.method(chromium, "launch", async (options: Parameters<typeof chromium.launch>[0]) => {
        const renderingBrowser = await launch(options);
        t.after(() => renderingBrowser.close());
        const newContext = renderingBrowser.newContext.bind(renderingBrowser);
        t.mock.method(
          renderingBrowser,
          "newContext",
          async (contextOptions: Parameters<Browser["newContext"]>[0]) => {
            const context = await newContext(contextOptions);
            observePdf(t, context, states);
            return context;
          },
        );
        return renderingBrowser;
      });
      const result = await runReconstruction({
        books: [book],
        outDir: join(root, "output"),
        tempRoot: join(root, "extracted"),
        browserPath: executablePath,
        navigationTimeoutMs: 10_000,
        keepExtracted: false,
        concurrency: 1,
        emit: () => {},
      });
      assert.deepEqual(result.failed, []);
      assert.equal(result.succeeded.length, 1);
      output = result.succeeded[0]!;
    } else {
      const context = await browser.newContext({ viewport });
      t.after(() => context.close());
      await context.route("https://reading-order.test/**", (route) =>
        route.fulfill({ contentType: "text/html", body: printFixture }),
      );
      observePdf(t, context, states);
      output = join(root, "remote.pdf");
      await renderRemoteBookToPdf({
        remoteBookBaseUrl: "https://reading-order.test/",
        book,
        context,
        outputPdfPath: output,
        navigationTimeoutMs: 10_000,
        tempRoot: join(root, "remote"),
      });
    }

    assert.equal(states.length, 1);
    assert.equal(states[0]!.print, true);
    assert.equal(states[0]!.children.length, 1);
    assert.equal(states[0]!.children[0]!.text, "First line second line");
    assert.equal(states[0]!.children[0]!.x, 20);
    assert.equal(states[0]!.children[0]!.y, 40);
    const pdf = await PDFDocument.load(await readFile(output));
    assert.equal(pdf.getPageCount(), 1);
    assert.deepEqual(pdf.getPage(0).getSize(), { width: 600, height: 450 });
  });
}
