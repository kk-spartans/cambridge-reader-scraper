let
  flake = builtins.getFlake (toString ../.);
in
flake.legacyPackages.${builtins.currentSystem}
