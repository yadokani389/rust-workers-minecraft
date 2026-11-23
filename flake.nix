{
  description = "Development shell for Minecraft on Workers";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    git-hooks = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.treefmt-nix.flakeModule
        inputs.git-hooks.flakeModule
      ];
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      perSystem =
        { config, pkgs, ... }:
        let
          rustPkgs = pkgs.extend inputs.rust-overlay.overlays.default;
          rust = rustPkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
        in
        {
          devShells.default = pkgs.mkShell {
            inputsFrom = [ config.pre-commit.devShell ];
            nativeBuildInputs = with pkgs; [
              git
              nodejs_24
              pnpm_12
              python3
              pkg-config
              gnumake
              rust
            ];
            buildInputs = [ pkgs.openssl ];
            HOST_CFLAGS = "-O1";
            CC_wasm32_unknown_emscripten = "emcc";
            CXX_wasm32_unknown_emscripten = "em++";
            AR_wasm32_unknown_emscripten = "emar";
          };

          treefmt = {
            projectRootFile = "flake.nix";
            programs = {
              nixfmt.enable = true;
              rustfmt = {
                enable = true;
                package = rust;
                edition = "2021";
              };
              oxfmt = {
                enable = true;
                includes = [
                  "*.js"
                  "*.mjs"
                ];
              };
            };
          };

          pre-commit.settings.hooks.treefmt.enable = true;
        };
    };
}
