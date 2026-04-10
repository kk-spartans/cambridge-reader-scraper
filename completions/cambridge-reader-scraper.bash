_cambridge_reader_scraper() {
  local cur prev command
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  command="${COMP_WORDS[1]}"

  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "reconstruct pdf inspect completion help --userdata --app-name --isbn --outdir --workdir --browser --page-timeout-ms --max-pages --concurrency --keep-extracted --no-tui --help" -- "${cur}") )
    return 0
  fi

  if [[ "${command}" == "completion" && ${COMP_CWORD} -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "bash zsh fish powershell xonsh" -- "${cur}") )
    return 0
  fi

  COMPREPLY=( $(compgen -W "--userdata --app-name --isbn --outdir --workdir --browser --page-timeout-ms --max-pages --concurrency --keep-extracted --no-tui --help" -- "${cur}") )
}

complete -F _cambridge_reader_scraper cambridge-reader-scraper
