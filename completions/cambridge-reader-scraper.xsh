def _complete_cambridge_reader_scraper(prefix, line, begidx, endidx, ctx=None):
    commands = ["reconstruct", "pdf", "inspect", "completion", "help"]
    options = ["--userdata", "--app-name", "--isbn", "--outdir", "--workdir", "--browser", "--page-timeout-ms", "--max-pages", "--concurrency", "--keep-extracted", "--no-tui", "--help"]
    shells = ["bash", "zsh", "fish", "powershell", "xonsh"]
    tokens = line[:endidx].split()

    if len(tokens) <= 1:
        return {item for item in commands + options if item.startswith(prefix)}

    if len(tokens) == 2 and tokens[1] == 'completion':
        return {item for item in shells if item.startswith(prefix)}

    return {item for item in options if item.startswith(prefix)}


completer add cambridge_reader_scraper _complete_cambridge_reader_scraper end
