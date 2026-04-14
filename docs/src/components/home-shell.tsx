"use client";

import { motion } from "framer-motion";
import Link from "next/link";

const installCommand = "bunx playwright install chromium\nbunx cambridge-reader-scraper";

const fadeInUp = {
  hidden: { opacity: 0, y: 18 },
  visible: { opacity: 1, y: 0 },
};

export function HomeShell() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-20 sm:px-10 lg:px-12">
      <section className="grid gap-10 lg:grid-cols-[1.2fr_0.9fr] lg:items-start">
        <motion.div
          variants={fadeInUp}
          initial="hidden"
          animate="visible"
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-8"
        >
          <div className="space-y-4">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-500">
              Cambridge Reader Scraper
            </p>
            <h1 className="max-w-3xl text-balance text-5xl font-semibold tracking-tight text-zinc-100 sm:text-6xl">
              Rebuild Cambridge Reader books into clean PDFs.
            </h1>
            <p className="max-w-2xl text-pretty text-lg leading-8 text-zinc-400">
              Read local book blobs, pick titles, and export PDFs without fighting the reader app.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/docs"
              className="rounded-lg border border-zinc-700 bg-zinc-200 px-5 py-2.5 font-medium text-zinc-950 transition hover:bg-zinc-100 hover:text-zinc-950"
            >
              Open Docs
            </Link>
            <Link
              href="https://github.com/kk-spartans/cambridge-reader-scraper"
              className="rounded-lg border border-zinc-800 px-5 py-2.5 font-medium text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100"
            >
              GitHub
            </Link>
          </div>
        </motion.div>

        <motion.div
          variants={fadeInUp}
          initial="hidden"
          animate="visible"
          transition={{ duration: 0.5, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
          className="rounded-xl border border-zinc-900 bg-zinc-950 p-5"
        >
          <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-zinc-500">
            Quick start
          </p>
          <pre className="overflow-x-auto rounded-lg bg-black p-4 text-sm text-zinc-100">
            <code>{installCommand}</code>
          </pre>
          <p className="mt-4 text-sm leading-7 text-zinc-400">
            If you skip <code>--outdir</code>, the CLI asks once and defaults to <code>out</code>.
          </p>
        </motion.div>
      </section>
    </main>
  );
}
