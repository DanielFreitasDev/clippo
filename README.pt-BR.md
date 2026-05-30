# Clippo

[English](README.md) · **Português (Brasil)**

Gerenciador de histórico da área de transferência para o **GNOME Shell** (Wayland),
feito como extensão nativa do GNOME. Captura tudo que você copia e abre o histórico
com **Super+V** na posição do mouse.

## Recursos

- Captura automática de tudo que é copiado como texto (cópias marcadas como secretas por um gerenciador de senhas são ignoradas).
- **Super+V** abre o popup na posição do cursor.
- Histórico em ordem decrescente (a cópia mais recente no topo).
- Mostra as **25** últimas cópias por padrão (configurável de 1 a 500).
- Barra de busca com foco automático: digite para filtrar, apague para voltar à lista.
- Navegação por teclado: **↑/↓** move, **Enter** seleciona, **Delete** remove (**Shift+Delete** durante a busca), **Esc** fecha.
- Selecionar um item devolve o conteúdo ao clipboard (cole com **Ctrl+V**) e fecha a janela.
- A janela fecha ao selecionar, ao apertar Esc, ao clicar fora ou ao perder o foco.
- **Itens fixados (favoritos):** clique na estrela; ficam no topo e não somem pelo limite.
- **Limpar histórico:** botão da lixeira (mantém os fixados).
- **Ícone na barra superior** (opcional) para abrir com o mouse.
- Persiste entre logout/reboot em `~/.local/share/clippo/history.json` (permissões `600`).
- Inicia junto com a sessão (extensões do Shell rodam no login, sem autostart).
- **UI localizada:** acompanha o idioma do sistema — inglês e português do Brasil inclusos, com inglês como padrão.

## Por que uma extensão do GNOME?

No GNOME/Wayland, só o processo do Shell tem acesso privilegiado à área de transferência
em segundo plano (`Meta.Selection`), pode registrar um atalho global como Super+V e
posicionar a janela na posição do cursor. Apps independentes (CopyQ, etc.) não conseguem
fazer isso no GNOME Wayland.

## Instalação

```bash
./install.sh
```

Depois:

1. **Faça logout e login** (no Wayland o gnome-shell não pode ser reiniciado em sessão).
2. Habilite:
   ```bash
   gnome-extensions enable clippo@daniel.local
   ```
3. Pressione **Super+V**.

> O Clippo assume o atalho **Super+V** (normalmente usado pela *bandeja de mensagens*)
> enquanto está ativo; o **Super+M** continua abrindo a bandeja. Ao desabilitar a
> extensão, o Super+V é devolvido à bandeja.

## Preferências

```bash
gnome-extensions prefs clippo@daniel.local
```

Permite ajustar o número de itens, mostrar/ocultar o ícone da barra e trocar o atalho.

## Desenvolvimento

A extensão é JavaScript puro (GJS, ESM, GNOME 45+), **sem etapa de build** — os arquivos
do projeto são o próprio código (via symlink do `install.sh`).

- Aplicar mudanças no código: **logout/login** (limitação do Wayland).
- Re-rodar `enable()`/`disable()` sem novo código:
  ```bash
  gnome-extensions disable clippo@daniel.local && gnome-extensions enable clippo@daniel.local
  ```
- Logs do shell:
  ```bash
  journalctl -f -o cat /usr/bin/gnome-shell
  ```
- Console interativo: `Alt+F2` → `lg` → Enter (Looking Glass).
- Ao mudar `schemas/*.gschema.xml`, recompile: `glib-compile-schemas schemas/`.

### Traduções

A UI é localizada com gettext (domínio `clippo`). As strings de origem estão em
inglês; as traduções ficam em `po/<idioma>.po` e são compiladas para
`locale/<idioma>/LC_MESSAGES/clippo.mo` pelo `install.sh` (requer o pacote
`gettext` — `sudo apt install gettext`). Sem tradução compilada para o idioma
ativo, a UI cai no inglês.

Para adicionar um idioma, copie `po/clippo.pot` para `po/<idioma>.po` (ex.:
`po/fr.po`), preencha cada `msgstr` e rode `./install.sh` de novo. Ao mudar as
strings no código, regenere o template:

```bash
xgettext --from-code=UTF-8 -L JavaScript --keyword=_ -o po/clippo.pot prefs.js lib/*.js
```

### Empacotar para distribuição

```bash
gnome-extensions pack --extra-source=lib --extra-source=stylesheet.css .
gnome-extensions install --force clippo@daniel.local.shell-extension.zip
```

## Estrutura

| Arquivo | Função |
|---|---|
| `extension.js` | Ciclo de vida; conecta monitor ↔ store ↔ popup ↔ ícone; atalho. |
| `lib/clipboardManager.js` | Monitora o clipboard (`Meta.Selection`), emite `text-copied`. |
| `lib/historyStore.js` | Histórico + fixados em memória e em JSON atômico. |
| `lib/clipboardPopup.js` | UI do popup: busca, lista, teclado, grab modal, fechamento. |
| `lib/indicator.js` | Ícone na barra superior. |
| `prefs.js` | Preferências (libadwaita). |
| `schemas/` | Schema GSettings (`max-items`, `toggle-clippo`, `show-indicator`). |
| `po/` | Catálogos de tradução (gettext); compilados para `locale/` na instalação. |

## Limitações conhecidas / futuro

- **Somente texto** na v1 (imagens ficam para depois).
- O Clippo ignora cópias que um **gerenciador de senhas** marca como secretas (pelo hint `x-kde-passwordManagerHint`), mas uma senha copiada de outro lugar ainda é capturada como texto comum (mitigação: arquivo `600`).
  Futuro: modo privado completo e exclusão por app.
