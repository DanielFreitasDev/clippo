#!/usr/bin/env bash
#
# Instala o Clippo criando um symlink do diretório do projeto para a pasta de
# extensões do GNOME e compilando os schemas. Edições no projeto ficam "ao vivo"
# (basta deslogar/logar para o gnome-shell recarregar o código no Wayland).

set -euo pipefail

UUID="clippo@daniel.local"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

# Compila os schemas no próprio projeto (necessário no modo symlink).
glib-compile-schemas "$SRC/schemas"

mkdir -p "$(dirname "$DEST")"
ln -sfn "$SRC" "$DEST"

echo "Clippo instalado: $DEST -> $SRC"
echo
echo "Próximos passos:"
echo "  1. Faça logout e login (no Wayland não dá para reiniciar o gnome-shell)."
echo "  2. Habilite a extensão:"
echo "       gnome-extensions enable $UUID"
echo "  3. Pressione Super+V para abrir o histórico."
echo
echo "Preferências:  gnome-extensions prefs $UUID"
echo "Logs:          journalctl -f -o cat /usr/bin/gnome-shell"
