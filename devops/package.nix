{
  lib,
  stdenv,
  nodejs_24,
  pnpm,
  pnpmConfigHook,
  fetchPnpmDeps,
  cacert,
}:

let
  pkg = builtins.fromJSON (builtins.readFile ../package.json);
  version = pkg.version;
  pname = pkg.name;

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
in
stdenv.mkDerivation {
  inherit pname version;
  inherit src;

  pnpmDeps = fetchPnpmDeps {
    inherit pname version src;
    hash = "sha256-QKwKo2HcBkRCEYUAm/IEowzJjOLJT9GdJBD5MDelkng=";
    fetcherVersion = 4;
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm
    pnpmConfigHook
  ];
  buildInputs = [ cacert ];

  buildPhase = ''
    runHook preBuild
    export SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt
    export CAMBRIDGE_READER_SCRAPER_DOCKER=1
    pnpm run check
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    export SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt
    pnpm install --prod --offline --frozen-lockfile
    mkdir -p $out/bin $out/lib/cambridge-reader-scraper
    cp -r dist package.json $out/lib/cambridge-reader-scraper/
    cp -r node_modules $out/lib/cambridge-reader-scraper/node_modules
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
