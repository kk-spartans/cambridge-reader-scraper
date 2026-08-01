{
  pkgs,
  lib,
  config,
  inputs,
  ...
}:
{
  packages = with pkgs; [
    gitleaks
    nodejs_24
    pnpm
    usage
    nixfmt
    docker
    arion
    docker-compose
  ];

  languages = {
    javascript = {
      enable = true;
      pnpm = {
        enable = true;
        install.enable = true;
      };
    };
    typescript.enable = true;
  };

  dotenv.enable = true;

  git-hooks.hooks.check = {
    enable = true;
    name = "check";
    entry = "devenv tasks run cambridge-reader-scraper:check";
    pass_filenames = false;
    language = "system";
  };

  tasks = {
    "cambridge-reader-scraper:check".exec = "pnpm run check";
    "cambridge-reader-scraper:start".exec = "pnpm run start";
    "cambridge-reader-scraper:release".exec = "pnpm run release";
    "cambridge-reader-scraper:scrape".exec = "arion -f devops/arion-compose.nix -p devops/arion-pkgs.nix run --rm scraper";
  };
}
