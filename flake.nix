{
  description = "Copilot for Obsidian — Node/TypeScript plugin development";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Wrapper used by apps.* — ensures npm deps (jest, husky) exist before running.
        withNodeModules = script: pkgs.writeShellScript "copilot-nix-${script.name}" ''
          set -euo pipefail
          cd "${self}"
          export PATH="$PWD/node_modules/.bin:${pkgs.nodejs_22}/bin:$PATH"

          if [ ! -x node_modules/.bin/jest ] || [ ! -x node_modules/.bin/husky ]; then
            echo "Installing npm dependencies (jest, husky, …)…"
            npm ci --no-fund
          fi

          export PATH="$PWD/node_modules/.bin:$PATH"
          exec ${script.body}
        '';

        testApp = withNodeModules {
          name = "test";
          body = ''jest --testPathIgnorePatterns=src/integration_tests/ "$@"'';
        };

        huskyApp = withNodeModules {
          name = "husky";
          body = "husky";
        };
      in
      {
        apps = {
          # nix run .#test -- [jest args]
          test = {
            type = "app";
            program = "${testApp}";
          };
          # nix run .#husky — (re)install git hooks (same as npm run prepare)
          husky = {
            type = "app";
            program = "${huskyApp}";
          };
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            git
          ];

          shellHook = ''
            echo "Obsidian Copilot dev shell (Node $(node --version), npm $(npm --version))"

            # jest, husky, eslint, etc. come from package.json — expose after npm ci
            if [ -d "$PWD/node_modules/.bin" ]; then
              export PATH="$PWD/node_modules/.bin:$PATH"
            fi

            if [ -x node_modules/.bin/jest ] && [ -x node_modules/.bin/husky ]; then
              echo "  jest   $(jest --version 2>/dev/null || true)  — npm test, or: nix run .#test"
              # Intentionally avoid running `husky --version`: Husky v9 treats its first
              # argument as a directory path, so `husky --version` would silently run
              # `git config core.hooksPath "--version"` and corrupt the repo config.
              _husky_ver=$(node -e "try{process.stdout.write(require('./node_modules/husky/package.json').version)}catch(e){}" 2>/dev/null || true)
              echo "  husky  ''${_husky_ver:-(installed)} — hooks in .husky/; refresh: nix run .#husky"
              unset _husky_ver
            else
              echo "  jest, husky  — not installed yet; run: npm ci  (or: nix run .#test)"
            fi

            echo "  Prefix commands with: nix develop -c <command>"
          '';
        };
      }
    );
}
