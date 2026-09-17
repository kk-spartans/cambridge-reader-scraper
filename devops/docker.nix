{
  lib,
  dockerTools,
  nodejs_24,
  cacert,
  callPackage,
}:

let
  app = callPackage ./package.nix { };
  image = dockerTools.buildLayeredImage {
    name = "ghcr.io/kk-spartans/cambridge-reader-scraper/cambridge-reader-scraper-app";
    tag = "latest";
    contents = [
      app
      nodejs_24
      cacert
    ];
    fakeRootCommands = ''
      mkdir -p ./tmp
      chmod 1777 ./tmp
    '';
    config = {
      Cmd = [
        "${nodejs_24}/bin/node"
        "${app}/lib/cambridge-reader-scraper/dist/cambridge-reader-scraper"
      ];
      Env = [
        "PATH=${nodejs_24}/bin"
        "NODE_ENV=production"
        "CAMBRIDGE_READER_SCRAPER_DOCKER=1"
        "SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt"
        "NODE_EXTRA_CA_CERTS=${cacert}/etc/ssl/certs/ca-bundle.crt"
        "TMPDIR=/tmp"
      ];
    };
  };
in
image
// {
  isExe = false;
  passthru = (image.passthru or { }) // {
    isExe = false;
  };

  meta = {
    description = "Cambridge Reader scraper Docker image";
    license = lib.licenses.unlicense;
    mainProgram = "cambridge-reader-scraper";
  };
}
