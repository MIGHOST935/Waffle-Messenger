{ pkgs }: {
  deps = [
    pkgs.psmisc
    pkgs.lsof
    pkgs.nodePackages.vscode-langservers-extracted
    pkgs.nodePackages.typescript-language-server
  ];
}