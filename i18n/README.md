# Translating

## How to Contribute Translations

Guava OS ships in English for now: no translation has been contributed yet.

- To add a language, copy `i18n/guava.pot` to `i18n/po/<lang>.po` (for example `i18n/po/de.po`),
  translate the strings, and open a pull request. Native speakers only, please: machine
  translations are not accepted.
- `make pot` regenerates `guava.pot` from the sources; merge it into your file with
  `msgmerge --update i18n/po/<lang>.po i18n/guava.pot`.
- Run `./compile-translations.sh` to validate your file and build `.mo` files for local testing.

## Compiling translations for testing

The helper script compiles translations and produces a `locale/` folder for local testing. Run:

```bash
./compile-translations.sh
```

## Packaging

When packing the extension you can point `gnome-extensions pack` at the `i18n/po/` directory:

```bash
gnome-extensions pack --podir=po
```

## Further Reading

- [GJS translations guide](https://gjs.guide/extensions/development/translations.html)
- [GNOME Translation Project](https://wiki.gnome.org/TranslationProject)
