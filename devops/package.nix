{
  lib,
  stdenv,
  nodejs_24,
  pnpm,
  cacert,
}:

let
  pkg = builtins.fromJSON (builtins.readFile ../package.json);
in
stdenv.mkDerivation {
  inherit (pkg) name version;

  src = lib.cleanSourceWith {
    src = ../.;
    filter =
      name: type:
      let
        baseName = baseNameOf (toString name);
      in
      !(
        type == "directory"
        && (
          baseName == "node_modules"
          || baseName == ".devenv"
          || baseName == ".git"
          || baseName == "dist"
          || baseName == ".direnv"
        )
      );
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm
  ];
  buildInputs = [ cacert ];

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    export SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt
    pnpm install --frozen-lockfile
    pnpm run check
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/lib/cambridge-reader-scraper
    cp -r dist package.json $out/lib/cambridge-reader-scraper/
    ln -s $out/lib/cambridge-reader-scraper/dist/cambridge-reader-scraper $out/bin/cambridge-reader-scraper
    chmod +x $out/bin/cambridge-reader-scraper
    runHook postInstall
  '';

  meta = {
    description = pkg.description;
    homepage = "https://github.com/kk-spartans/cambridge-reader-scraper";
    license = lib.licenses.unlicense;
    mainProgram = "cambridge-reader-scraper";
  };
}
