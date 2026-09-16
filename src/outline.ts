import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  type PDFRef,
} from "pdf-lib";

import type { ChapterNode } from "./types.js";

type OutlineEntry = {
  title: string;
  pageIndex: number;
  children: OutlineEntry[];
};

function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, 500);
}

function toOutlineEntries(nodes: ChapterNode[], pageCount: number): OutlineEntry[] {
  const entries: OutlineEntry[] = [];

  for (const node of nodes) {
    const title = cleanTitle(node.title);
    const children = toOutlineEntries(node.children ?? [], pageCount);
    const pageIndex =
      typeof node.pageIndex === "number" && Number.isInteger(node.pageIndex)
        ? node.pageIndex - 1
        : undefined;
    const validPageIndex =
      pageIndex !== undefined && pageIndex >= 0 && pageIndex < pageCount ? pageIndex : undefined;

    if (validPageIndex === undefined) {
      // Unresolvable targets (e.g. cover pages outside the rendered slice) are
      // skipped, but their children are promoted so nothing is lost.
      entries.push(...children);
      continue;
    }

    if (!title) {
      entries.push(...children);
      continue;
    }

    entries.push({ title, pageIndex: validPageIndex, children });
  }

  return entries;
}

function countDescendants(entries: OutlineEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    count += 1 + countDescendants(entry.children);
  }
  return count;
}

type BuiltNode = {
  entry: OutlineEntry;
  ref: PDFRef;
  dict: PDFDict;
  parentRef: PDFRef;
  children: BuiltNode[];
};

export function setPdfOutline(pdfDoc: PDFDocument, chapters: ChapterNode[]): void {
  const pageCount = pdfDoc.getPageCount();
  if (!pageCount) {
    return;
  }

  const entries = toOutlineEntries(chapters, pageCount);
  if (!entries.length) {
    return;
  }

  const context = pdfDoc.context;
  const pages = pdfDoc.getPages();
  const outlinesRef = context.nextRef();

  const buildNodes = (items: OutlineEntry[], parentRef: PDFRef): BuiltNode[] =>
    items.map((entry) => {
      const ref = context.nextRef();
      const dict = PDFDict.withContext(context);
      const node: BuiltNode = { entry, ref, dict, parentRef, children: [] };
      node.children = buildNodes(entry.children, ref);
      return node;
    });

  const topNodes = buildNodes(entries, outlinesRef);
  const allNodes: BuiltNode[] = [];
  const collect = (nodes: BuiltNode[]): void => {
    for (const node of nodes) {
      allNodes.push(node);
      collect(node.children);
    }
  };
  collect(topNodes);

  const linkSiblings = (nodes: BuiltNode[], parentRef: PDFRef): void => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (!node) {
        continue;
      }
      const prev = nodes[index - 1];
      const next = nodes[index + 1];
      node.dict.set(PDFName.of("Title"), PDFHexString.fromText(node.entry.title));
      node.dict.set(PDFName.of("Parent"), parentRef);
      if (prev) {
        node.dict.set(PDFName.of("Prev"), prev.ref);
      }
      if (next) {
        node.dict.set(PDFName.of("Next"), next.ref);
      }

      const page = pages[node.entry.pageIndex];
      if (page) {
        const dest = PDFArray.withContext(context);
        dest.push(page.ref);
        dest.push(PDFName.of("Fit"));
        node.dict.set(PDFName.of("Dest"), dest);
      } else {
        node.dict.set(PDFName.of("Dest"), PDFNull);
      }

      const firstChild = node.children[0];
      const lastChild = node.children[node.children.length - 1];
      if (node.children.length && firstChild && lastChild) {
        const descendantCount = countDescendants(node.entry.children);
        node.dict.set(PDFName.of("First"), firstChild.ref);
        node.dict.set(PDFName.of("Last"), lastChild.ref);
        node.dict.set(PDFName.of("Count"), PDFNumber.of(descendantCount));
        linkSiblings(node.children, node.ref);
      }
    }
  };
  linkSiblings(topNodes, outlinesRef);

  const firstTop = topNodes[0];
  const lastTop = topNodes[topNodes.length - 1];
  if (!firstTop || !lastTop) {
    return;
  }

  const outlinesDict = PDFDict.withContext(context);
  outlinesDict.set(PDFName.of("Type"), PDFName.of("Outlines"));
  outlinesDict.set(PDFName.of("First"), firstTop.ref);
  outlinesDict.set(PDFName.of("Last"), lastTop.ref);
  outlinesDict.set(PDFName.of("Count"), PDFNumber.of(countDescendants(entries)));

  for (const node of allNodes) {
    context.assign(node.ref, node.dict);
  }
  context.assign(outlinesRef, outlinesDict);

  pdfDoc.catalog.set(PDFName.of("Outlines"), outlinesRef);
  pdfDoc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}
