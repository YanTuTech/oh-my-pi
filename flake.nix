{
  description = "Oh My Pi Agent Runtime development environment";

  nixConfig = {
    extra-substituters = [ "https://nix-community.cachix.org" ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # nixpkgs unstable dropped Intel macOS in 26.11; keep that supported
    # platform on the final stable branch that still receives security fixes.
    nixpkgs-darwin-x64.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # bun2nix's per-system helper packages must use the same Intel-compatible
    # package set as the derivation consuming its overlay.
    bun2nix-darwin-x64 = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs-darwin-x64";
      inputs.systems.url = "github:nix-systems/x86_64-darwin";
    };

    nix-bun = {
      url = "github:ryoppippi/nix-bun";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      bun2nix,
      bun2nix-darwin-x64,
      nix-bun,
      nixpkgs,
      nixpkgs-darwin-x64,
      rust-overlay,
      ...
    }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      nixpkgsFor = system: if system == "x86_64-darwin" then nixpkgs-darwin-x64 else nixpkgs;
      bun2nixFor = system: if system == "x86_64-darwin" then bun2nix-darwin-x64 else bun2nix;
      pkgsFor =
        system:
        import (nixpkgsFor system) {
          inherit system;
          overlays = [
            rust-overlay.overlays.default
            (bun2nixFor system).overlays.default
            (final: _previous: {
              # Instantiate the pinned upstream binary against this package
              # set so Intel macOS does not re-enter nix-bun's unstable input.
              bun = final.callPackage (nix-bun.outPath + "/package.nix") {
                sourcesFile = nix-bun.outPath + "/versions/1.4.0.json";
              };
            })
          ];
        };
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
        in
        {
          default = import ./nix/dev-shell.nix { inherit pkgs rustToolchain; };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          bun-lock = pkgs.runCommand "omp-bun-lock" { nativeBuildInputs = [ pkgs.bun2nix ]; } ''
            cp -R ${self.outPath} source
            chmod -R u+w source
            cd source
            mv nix/bun.nix nix/bun.expected.nix
            bun2nix -l bun.lock -c ../ -o nix/bun.nix
            diff -u nix/bun.expected.nix nix/bun.nix
            touch "$out"
          '';
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt);
    };
}
