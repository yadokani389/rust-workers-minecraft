{
  description = "Development shell for Minecraft on Workers";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      perSystem = { pkgs, ... }:
        let
          rustPkgs = pkgs.extend inputs.rust-overlay.overlays.default;
          rust = rustPkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
        in {
          devShells.default = pkgs.mkShell {
            nativeBuildInputs = with pkgs; [ git nodejs_24 pnpm_12 python3 pkg-config gnumake rust ];
            buildInputs = [ pkgs.openssl ];
            HOST_CFLAGS = "-O1";
            CC_wasm32_unknown_emscripten = "emcc";
            CXX_wasm32_unknown_emscripten = "em++";
            AR_wasm32_unknown_emscripten = "emar";
          };
        };
    };
}
