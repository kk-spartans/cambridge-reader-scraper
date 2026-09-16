import type { Page } from "playwright-core";

export type ReadingOrderStats = {
  textBlocks: number;
  reorderedParents: number;
  mergedParagraphs: number;
};

/**
 * Reorders the page DOM into visual reading order before printing.
 *
 * Must stay self-contained (no references outside its own body): Playwright
 * serializes the compiled function and runs it inside the browser. Kept
 * module-private; the entry point is {@link normalizePrintReadingOrder}.
 */
function normalizeDocumentReadingOrder(): ReadingOrderStats {
  type Box = {
    element: Element;
    top: number;
    left: number;
    width: number;
    height: number;
    fontSize: number;
    fontWeight: string;
    fontStyle: string;
    textAlign: string;
    letterSpacing: string;
    position: string;
    tag: string;
    text: string;
    whiteSpace: string;
    transform: string;
    zIndex: string;
  };

  type BoxGroup = {
    parent: Element;
    boxes: Box[];
  };

  const stats: ReadingOrderStats = { textBlocks: 0, reorderedParents: 0, mergedParagraphs: 0 };
  const body = document.body;
  if (!body) {
    return stats;
  }

  const isRtl = getComputedStyle(body).direction === "rtl";
  const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "SVG", "MATH"]);
  const mergeableTags = new Set([
    "DIV",
    "P",
    "SPAN",
    "SECTION",
    "ARTICLE",
    "LI",
    "BLOCKQUOTE",
    "ASIDE",
  ]);
  const listMarkerPattern = /^(?:[•‣▪◦–-]\s*|\d+[.)]\s*|[a-z][.)]\s*)/i;

  function isHidden(element: Element): boolean {
    if (typeof HTMLElement !== "undefined" && element instanceof HTMLElement && element.hidden) {
      return true;
    }
    const style = getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
  }

  function directText(element: Element): string {
    let text = "";
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === 3) {
        text += node.textContent ?? "";
      }
    }
    return text.replace(/\s+/g, " ").trim();
  }

  function collect(element: Element, boxes: Box[]): boolean {
    if (skipTags.has(element.tagName) || isHidden(element)) {
      return false;
    }

    // Claim the whole subtree as one box when the element itself carries text.
    // This keeps inline styled runs (bold, colored spans) glued to their line
    // instead of becoming separate out-of-order blocks in the PDF.
    const text = directText(element);
    if (text) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return true;
      }
      const style = getComputedStyle(element);
      // Full subtree text: nested inline runs belong to this line.
      const fullText = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      boxes.push({
        element,
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        fontSize: Number.parseFloat(style.fontSize) || 0,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        textAlign: style.textAlign,
        letterSpacing: style.letterSpacing,
        position: style.position,
        tag: element.tagName,
        text: fullText,
        whiteSpace: style.whiteSpace,
        transform: style.transform,
        zIndex: style.zIndex,
      });
      return true;
    }

    let found = false;
    for (const child of Array.from(element.children)) {
      if (collect(child, boxes)) {
        found = true;
      }
    }
    return found;
  }

  function verticalOverlap(a: Box, top: number, bottom: number): boolean {
    const overlap = Math.min(a.top + a.height, bottom) - Math.max(a.top, top);
    return overlap > 0.4 * Math.min(a.height, bottom - top);
  }

  function sortRowMajor(boxes: Box[]): Box[] {
    const byTop = [...boxes].sort((a, b) => a.top - b.top || a.left - b.left);
    const rows: Box[][] = [];
    for (const box of byTop) {
      const row = rows[rows.length - 1];
      if (row && row.length > 0) {
        let rowTop = Number.POSITIVE_INFINITY;
        let rowBottom = Number.NEGATIVE_INFINITY;
        for (const item of row) {
          rowTop = Math.min(rowTop, item.top);
          rowBottom = Math.max(rowBottom, item.top + item.height);
        }
        if (verticalOverlap(box, rowTop, rowBottom)) {
          row.push(box);
          continue;
        }
      }
      rows.push([box]);
    }

    const out: Box[] = [];
    for (const row of rows) {
      row.sort((a, b) => (isRtl ? b.left - a.left : a.left - b.left));
      out.push(...row);
    }
    return out;
  }

  function findColumnSplit(boxes: Box[]): number | undefined {
    if (boxes.length < 2) {
      return undefined;
    }
    let minTop = Number.POSITIVE_INFINITY;
    let maxBottom = Number.NEGATIVE_INFINITY;
    const heights: number[] = [];
    for (const box of boxes) {
      minTop = Math.min(minTop, box.top);
      maxBottom = Math.max(maxBottom, box.top + box.height);
      heights.push(box.height);
    }
    const totalSpan = maxBottom - minTop;
    if (!(totalSpan > 0)) {
      return undefined;
    }
    heights.sort((a, b) => a - b);
    const medianHeight = heights[Math.floor(heights.length / 2)] ?? 0;
    const minGap = Math.max(24, medianHeight);

    const edges: number[] = [];
    for (const box of boxes) {
      edges.push(box.left, box.left + box.width);
    }
    edges.sort((a, b) => a - b);

    let best: number | undefined;
    let bestWidth = 0;
    for (let i = 0; i + 1 < edges.length; i += 1) {
      const left = edges[i];
      const right = edges[i + 1];
      if (left === undefined || right === undefined || right - left < minGap) {
        continue;
      }
      const mid = (left + right) / 2;
      let crosses = false;
      const onLeft: Box[] = [];
      const onRight: Box[] = [];
      for (const box of boxes) {
        if (box.left < mid && box.left + box.width > mid) {
          crosses = true;
          break;
        }
        const center = box.left + box.width / 2;
        if (center < mid) {
          onLeft.push(box);
        } else {
          onRight.push(box);
        }
      }
      if (crosses || onLeft.length === 0 || onRight.length === 0) {
        continue;
      }
      const span = (group: Box[]): number => {
        let top = Number.POSITIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;
        for (const box of group) {
          top = Math.min(top, box.top);
          bottom = Math.max(bottom, box.top + box.height);
        }
        return bottom - top;
      };
      if (span(onLeft) < 0.55 * totalSpan || span(onRight) < 0.55 * totalSpan) {
        continue;
      }
      if (right - left > bestWidth) {
        bestWidth = right - left;
        best = mid;
      }
    }
    return best;
  }

  function sortBoxes(boxes: Box[]): Box[] {
    if (boxes.length < 2) {
      return [...boxes];
    }
    const split = findColumnSplit(boxes);
    if (split === undefined) {
      return sortRowMajor(boxes);
    }
    const onLeft: Box[] = [];
    const onRight: Box[] = [];
    for (const box of boxes) {
      const center = box.left + box.width / 2;
      if (center < split) {
        onLeft.push(box);
      } else {
        onRight.push(box);
      }
    }
    if (onLeft.length === 0 || onRight.length === 0) {
      return sortRowMajor(boxes);
    }
    const first = isRtl ? onRight : onLeft;
    const second = isRtl ? onLeft : onRight;
    return [...sortBoxes(first), ...sortBoxes(second)];
  }

  function orderGroup(boxes: Box[]): Box[] {
    // Full-width boxes (headings, figures) stay anchored by vertical position;
    // the remaining boxes are ordered column-aware around them.
    const widths = boxes.map((box) => box.width).sort((a, b) => a - b);
    const maxWidth = widths[widths.length - 1] ?? 0;
    const fullWidth = boxes
      .filter((box) => maxWidth > 0 && box.width >= 0.6 * maxWidth)
      .sort((a, b) => a.top - b.top);
    if (fullWidth.length === 0 || fullWidth.length === boxes.length) {
      return sortBoxes(boxes);
    }
    const rest = boxes.filter((box) => !fullWidth.includes(box));
    const orderedRest = sortBoxes(rest);
    let restTop = Number.POSITIVE_INFINITY;
    let restBottom = Number.NEGATIVE_INFINITY;
    for (const box of orderedRest) {
      restTop = Math.min(restTop, box.top);
      restBottom = Math.max(restBottom, box.top + box.height);
    }
    const above = fullWidth.filter((box) => box.top + box.height <= restTop + 1);
    const below = fullWidth.filter((box) => box.top >= restBottom - 1);
    const middle = fullWidth.filter((box) => !above.includes(box) && !below.includes(box));

    const out: Box[] = [...above];
    const pending = [...middle].sort((a, b) => a.top - b.top);
    for (const box of orderedRest) {
      while (pending.length > 0 && (pending[0]?.top ?? 0) + (pending[0]?.height ?? 0) <= box.top) {
        const next = pending.shift();
        if (next) {
          out.push(next);
        }
      }
      out.push(box);
    }
    out.push(...pending, ...below);
    return out;
  }

  function sameOrder(a: Box[], b: Box[]): boolean {
    return a.length === b.length && a.every((box, index) => box === b[index]);
  }

  function groupByParent(boxes: Box[]): BoxGroup[] {
    const groups = new Map<Element, Box[]>();
    for (const box of boxes) {
      const parent = box.element.parentElement;
      if (!parent) {
        continue;
      }
      const list = groups.get(parent);
      if (list) {
        list.push(box);
      } else {
        groups.set(parent, [box]);
      }
    }
    return [...groups.entries()].map(([parent, group]) => ({ parent, boxes: group }));
  }

  function isReorderable(group: BoxGroup): boolean {
    if (group.boxes.length < 2) {
      return false;
    }
    // Reordering absolutely positioned siblings cannot change the visual
    // layout, but it does fix the PDF text (selection/copy) order.
    // Keep siblings with different z-index values in place so paint order
    // (overlaps) is preserved.
    const zIndex = group.boxes[0]?.zIndex;
    return group.boxes.every(
      (box) => (box.position === "absolute" || box.position === "fixed") && box.zIndex === zIndex,
    );
  }

  const boxes: Box[] = [];
  collect(body, boxes);
  stats.textBlocks = boxes.length;

  for (const group of groupByParent(boxes)) {
    if (!isReorderable(group)) {
      continue;
    }
    const ordered = orderGroup(group.boxes);
    if (sameOrder(group.boxes, ordered)) {
      continue;
    }
    for (const box of ordered) {
      group.parent.append(box.element);
    }
    stats.reorderedParents += 1;
  }

  mergeParagraphLines(boxes);

  return stats;

  function pageHasFullBleedBackdrop(): boolean {
    const viewportWidth = document.documentElement.clientWidth || 0;
    const viewportHeight = document.documentElement.clientHeight || 0;
    const viewportArea = viewportWidth * viewportHeight;
    const candidates: Element[] = [document.documentElement, body, ...Array.from(body.children)];
    for (const element of candidates) {
      const backgroundImage = getComputedStyle(element).backgroundImage;
      if (!backgroundImage || backgroundImage === "none") {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (viewportArea > 0 && rect.width * rect.height >= 0.8 * viewportArea) {
        return true;
      }
    }
    // Full-page scans rendered as <img>/<canvas>/<svg> with a transparent text
    // overlay: reflowing the overlay would misalign it with the image.
    for (const media of Array.from(body.querySelectorAll("img, canvas, svg, video"))) {
      const rect = media.getBoundingClientRect();
      if (viewportArea > 0 && rect.width * rect.height >= 0.8 * viewportArea) {
        return true;
      }
    }
    return false;
  }

  function canMerge(box: Box): boolean {
    return (
      mergeableTags.has(box.tag) &&
      !box.whiteSpace.startsWith("pre") &&
      box.transform === "none" &&
      (box.position === "absolute" || box.position === "fixed")
    );
  }

  function joinLines(lines: string[]): string {
    let out = lines[0] ?? "";
    for (let i = 1; i < lines.length; i += 1) {
      const next = lines[i] ?? "";
      if (out.endsWith("-") && /^[a-z]/.test(next)) {
        out = out.slice(0, -1) + next;
      } else {
        out = `${out} ${next}`;
      }
    }
    return out;
  }

  function mergeParagraphLines(allBoxes: Box[]): void {
    if (pageHasFullBleedBackdrop()) {
      return;
    }

    for (const group of groupByParent(allBoxes)) {
      // DOM order already matches visual order for reordered groups; for
      // untouched groups only merge runs that are also visually consecutive.
      const inDomOrder = [...group.boxes].sort((a, b) => {
        const position = a.element.compareDocumentPosition(b.element);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
          return -1;
        }
        if (position & Node.DOCUMENT_POSITION_PRECEDING) {
          return 1;
        }
        return 0;
      });

      let run: Box[] = [];
      const flush = (): void => {
        if (run.length >= 2) {
          mergeRun(group.parent, run);
        }
        run = [];
      };

      for (const box of inDomOrder) {
        const prev = run[run.length - 1];
        if (!prev || !canMerge(box) || !canMerge(prev)) {
          flush();
          run = canMerge(box) ? [box] : [];
          continue;
        }
        const pitches: number[] = [];
        for (let i = 1; i < run.length; i += 1) {
          const a = run[i - 1];
          const b = run[i];
          if (a && b) {
            pitches.push(b.top - a.top);
          }
        }
        const sortedPitches = [...pitches].sort((a, b) => a - b);
        const medianPitch = sortedPitches[Math.floor(sortedPitches.length / 2)];
        // Without an established rhythm, compare against the line height.
        const reference = medianPitch ?? prev.height;
        const pitch = box.top - prev.top;
        const steadyPitch =
          reference > 0 &&
          pitch >= 0.5 * reference &&
          pitch <= (medianPitch === undefined ? 1.5 : 1.6) * reference;
        const continues = !listMarkerPattern.test(box.text);
        // A short line usually ends a paragraph (ragged last line), unless it
        // is a hyphenated word split across lines.
        let paragraphBreak = false;
        if (run.length >= 2 && !prev.text.endsWith("-")) {
          const lengths = run.map((item) => item.text.length).sort((a, b) => a - b);
          const medianLength = lengths[Math.floor(lengths.length / 2)] ?? 0;
          paragraphBreak = medianLength > 0 && prev.text.length < 0.6 * medianLength;
        }
        const sameColumn =
          Math.abs(box.left - prev.left) <= 4 &&
          Math.abs(box.width - prev.width) <= 6 &&
          box.fontSize === prev.fontSize &&
          box.fontWeight === prev.fontWeight &&
          box.fontStyle === prev.fontStyle &&
          box.textAlign === prev.textAlign &&
          box.letterSpacing === prev.letterSpacing &&
          box.position === prev.position &&
          box.tag === prev.tag;
        if (sameColumn && steadyPitch && continues && !paragraphBreak) {
          run.push(box);
        } else {
          flush();
          run = [box];
        }
      }
      flush();
    }
  }

  function mergeRun(parent: Element, run: Box[]): void {
    const first = run[0];
    if (!first) {
      return;
    }
    const lefts = run.map((box) => box.left).sort((a, b) => a - b);
    const widths = run.map((box) => box.width).sort((a, b) => a - b);
    const pitches: number[] = [];
    for (let i = 1; i < run.length; i += 1) {
      const a = run[i - 1];
      const b = run[i];
      if (a && b) {
        pitches.push(b.top - a.top);
      }
    }
    pitches.sort((a, b) => a - b);
    const left = lefts[Math.floor(lefts.length / 2)] ?? first.left;
    const width = widths[Math.floor(widths.length / 2)] ?? first.width;
    const pitch = pitches[Math.floor(pitches.length / 2)] ?? first.height;

    const source = getComputedStyle(first.element);
    const merged = document.createElement("div");
    merged.textContent = joinLines(
      run.map((box) => box.text.replace(/\s+/g, " ").trim()).filter(Boolean),
    );
    merged.style.position = first.position;
    merged.style.left = `${left}px`;
    merged.style.top = `${first.top}px`;
    merged.style.width = `${width}px`;
    merged.style.margin = "0";
    merged.style.padding = "0";
    merged.style.border = "0";
    merged.style.fontFamily = source.fontFamily;
    merged.style.fontSize = source.fontSize;
    merged.style.fontWeight = source.fontWeight;
    merged.style.fontStyle = source.fontStyle;
    merged.style.color = source.color;
    merged.style.letterSpacing = source.letterSpacing;
    merged.style.wordSpacing = source.wordSpacing;
    merged.style.textAlign = source.textAlign;
    merged.style.lineHeight = pitch > 0 ? `${pitch}px` : "normal";
    merged.style.whiteSpace = "normal";
    merged.style.opacity = source.opacity;
    merged.style.zIndex = first.zIndex;

    parent.insertBefore(merged, first.element);
    for (const box of run) {
      box.element.remove();
    }
    stats.mergedParagraphs += 1;
  }
}

export async function normalizePrintReadingOrder(page: Page): Promise<ReadingOrderStats> {
  // Playwright serializes the compiled function source into the browser.
  // Some toolchains (esbuild/tsx with keepNames) annotate nested functions
  // with a `__name(...)` helper that does not exist in the page, so provide
  // a no-op shim when the serialized source references it.
  const source = normalizeDocumentReadingOrder.toString();
  const script = source.includes("__name(")
    ? `(() => { const __name = (fn) => fn; return (${source})(); })()`
    : `(${source})()`;
  return page.evaluate<ReadingOrderStats>(script);
}
