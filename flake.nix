{
  description = "Cambridge Reader scraper";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    {
      self,
      nixpkgs,
      ...
    }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems f;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.callPackage ./devops/package.nix { };
          docker = pkgs.callPackage ./devops/docker.nix { };
        }
      );

      legacyPackages = forAllSystems (system: nixpkgs.legacyPackages.${system});

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/cambridge-reader-scraper";
        };
      });
    };
}
