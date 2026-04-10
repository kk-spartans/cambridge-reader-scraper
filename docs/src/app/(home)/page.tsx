import Link from "next/link";

export default function HomePage() {
  const installCommand = `bunx playwright install chromium\nbunx cambridge-reader-scraper`;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-16 px-6 py-16 sm:px-10 lg:px-12">
      <section className="grid gap-10 lg:grid-cols-[1.25fr_0.95fr] lg:items-center">
        <div className="space-y-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-4 py-1 text-sm text-cyan-100">
            PDF reconstruction for Cambridge Reader books
          </div>

          <div className="space-y-4">
            <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-white sm:text-6xl">
              Rebuild your Cambridge Reader books into actual PDFs.
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-slate-300">
              Inspect local Cambridge Reader blobs, choose the books you want, and render clean PDFs
              with a terminal UI, shell completions, and docs that do not suck.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/docs"
              className="rounded-xl bg-cyan-400 px-5 py-3 font-medium text-slate-950 transition hover:bg-cyan-300"
            >
              Open docs
            </Link>
            <Link
              href="/docs/shell-completions"
              className="rounded-xl border border-white/10 bg-white/5 px-5 py-3 font-medium text-white transition hover:bg-white/10"
            >
              Shell completions
            </Link>
            <Link
              href="https://github.com/kk-spartans/cambridge-reader-scraper"
              className="rounded-xl border border-white/10 bg-transparent px-5 py-3 font-medium text-slate-300 transition hover:border-white/20 hover:text-white"
            >
              GitHub
            </Link>
          </div>
        </div>

        <div className="rounded-3xl border border-white/10 bg-slate-950/70 p-5 shadow-2xl shadow-cyan-950/30 backdrop-blur">
          <div className="mb-4 flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-slate-400">
            Quick start
          </div>
          <pre className="overflow-x-auto rounded-2xl bg-slate-950 p-4 text-sm text-slate-100">
            <code>{installCommand}</code>
          </pre>
          <div className="mt-4 space-y-3 text-sm text-slate-300">
            <p>It now asks where to save the PDFs unless you pass `--outdir` yourself.</p>
            <p>Bun works. Past me was being dramatic.</p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          {
            title: "Interactive by default",
            body: "Pick books in the TUI, watch progress live, or disable it with --no-tui when you want pure script mode.",
          },
          {
            title: "Shell completions",
            body: "Bash, Zsh, Fish, PowerShell, and Xonsh are covered with generated installable completion scripts.",
          },
          {
            title: "Bun, pnpm, npm, npx, bunx",
            body: "Use the package manager you actually like instead of pretending only one exists.",
          },
          {
            title: "Static docs on Pages",
            body: "The docs ship as a Fumadocs static export and deploy to GitHub Pages from the same repo.",
          },
        ].map((item) => (
          <div
            key={item.title}
            className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur"
          >
            <h2 className="text-lg font-semibold text-white">{item.title}</h2>
            <p className="mt-2 text-sm leading-7 text-slate-300">{item.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
