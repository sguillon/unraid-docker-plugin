# Docker Template Editor for Unraid

Unraid saves every Docker container you create as an XML template on the flash drive
(`/boot/config/plugins/dockerMan/templates-user/my-*.xml`). The built-in edit form shows one
field at a time, which gets slow when a container has dozens of variables.

This plugin adds a **Templates** tab to the **Docker** page (shown while Docker is running):

| Feature | What it does |
| --- | --- |
| **Config grid** | Every Variable / Path / Port / Label / Device in one table. Filter by type, search, reorder, duplicate, delete. Changed rows are highlighted; masked values (passwords) stay hidden until you reveal them. Advanced attributes (default, mode, display, required, mask, description) are one click away. |
| **Bulk .env** | Edit all variables as `KEY=value` text. Paste a `.env` file or a docker-compose `environment:` block, preview the diff, then apply. |
| **General** | Name, repository, network, extra parameters, post arguments, WebUI, icon, and so on. |
| **Raw XML** | Edit the file directly, with validation before it is written. Uses the Ace code editor bundled with Unraid 7 (plain text box on 6.12). |
| **History** | The previous version is backed up on every save (last 25 per container, in `/boot/config/plugins/docker-template-editor/backups`). View a diff or restore. |
| **Bulk edit across containers** | Find & replace (plain or regex), set a value (for example `TZ` or `PUID`, optionally adding it where missing), or remove an entry across many templates, with a preview first. |

Saving only changes the template. To apply it to the container, either:
- **Apply in Unraid**: opens the saved template in Unraid's native editor; press *Apply*.
- **Recreate**: stops, removes and recreates the container using Unraid's own `xmlToCommand()`, which is what the native *Apply* runs.

Options are in **Settings → User Utilities → Docker Template Editor**: what to do after saving
(ask / recreate / open Unraid's editor / nothing), whether to confirm before recreating, the stop timeout, and how many backups to keep.

Saves are protected against overwriting changes made elsewhere (for example in the native editor), and
anything the editor doesn't know about (such as Tailscale elements) is kept untouched.

## Install

In Unraid: **Plugins → Install Plugin**, paste

```
https://raw.githubusercontent.com/sguillon/unraid-docker-plugin/main/docker-template-editor.plg
```

Requires Unraid 6.12 or newer.

## Development

```
src/usr/local/emhttp/plugins/docker-template-editor/   -> installed as-is on Unraid
  DockerTemplateEditor.page    Docker → Templates tab
  DockerTemplateEditorSettings.page  Settings → User Utilities
  default.cfg                  default settings (user values: /boot/config/plugins/docker-template-editor/*.cfg)
  include/Templates.php        read / validate / write templates, backups, bulk ops
  include/api.php              JSON API used by the page
  assets/editor.js, editor.css UI (vanilla JS, no build step)
docker-template-editor.plg     plugin installer
archive/                       local build output (git-ignored; releases hold the packages)
dev/                           local harness + sample templates
tests/TemplatesTest.php        backend tests
ca/                            Community Applications listing
```

Run locally (needs PHP 8.2+):

```bash
./dev/serve.sh --reset          # http://localhost:8765, ?page=settings, &theme=black, &ace=0
php tests/TemplatesTest.php
```

The dev server works on a scratch copy of `dev/fixtures`, never on real templates.

### Release

1. Add a `###YYYY.MM.DD` entry to `<CHANGES>` in `docker-template-editor.plg` and push it to `main`.
2. Tag and push: `git tag v2026.09.25 && git push origin v2026.09.25`
   (use a suffix like `v2026.09.25a` for a second release the same day).
3. The *Release* workflow runs the tests, builds the package, attaches it to a GitHub release, and commits
   the new version + MD5 to the `.plg` on `main`. Unraid checks `pluginURL` for updates.

`build/build.sh [version]` does the same build locally.

### Publishing on Community Applications

Community Applications lists plugins as well as Docker apps. To list this one:
1. Add a 256×256 PNG icon at `ca/icon.png`.
2. Open a support thread on the Unraid forums and point `<Support>` in `ca/docker-template-editor.xml` to it.
3. Put `ca/docker-template-editor.xml` in a public template repository and submit it following the
   [CA application policies](https://forums.unraid.net/topic/87144-ca-application-policies/).

## Credits

Structure and release flow inspired by [Compose Manager Plus](https://github.com/mstrhakr/compose_plugin).
