# Developer tasks for Guava OS. Needs: gnome-extensions, gettext, eslint, gjs.
UUID    := guava-os@blueyzx64
DESTDIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
DISTDIR := dist
POT     := translating/guava.pot
# Every source folder the zip needs. Keep in step with .github/workflows/pack-release.yml.
EXTRA   := icons lib core features prefs features.js
EXTRA_FLAGS := $(addprefix --extra-source=,$(EXTRA))
# Shell styles: stylesheet.css is built from these (and committed)
CSS_SRC := styles/base.css $(sort $(wildcard features/*/style.css))

.PHONY: all css css-check pack pack-check pot install uninstall test lint schema-check check clean smoke helper-rpm helper-install

all: check

# stylesheet.css = styles/base.css + features/*/style.css
css: stylesheet.css
stylesheet.css: $(CSS_SRC) tools/build-css.sh
	tools/build-css.sh

css-check:
	tools/build-css.sh --check

# Zip lands in $(DISTDIR)/$(UUID).shell-extension.zip
pack: css
	@mkdir -p $(DISTDIR)
	gnome-extensions pack --force $(EXTRA_FLAGS) --podir=po -o $(DISTDIR) .

# The zip holds what the extension loads, and nothing of the features v3 dropped
pack-check: pack
	tools/check-pack.sh $(DISTDIR)/$(UUID).shell-extension.zip

# Regenerate the translation template (translating/guava.pot) and po/POTFILES from every
# source file that has translatable strings. Sources are found recursively.
pot:
	@srcs=$$(ls extension.js prefs.js features.js 2>/dev/null; find lib core features prefs -name '*.js' | sort) && \
	xgettext --from-code=UTF-8 --language=JavaScript \
		-k_ -kN_ -kgettext -kgettextFunc -k_gettext --add-comments=TRANSLATORS \
		--package-name="Guava OS" --package-version=1.0.0 \
		--copyright-holder="Arnis Kemlers, blueyzx64" \
		--msgid-bugs-address=https://github.com/blueyzx64/guava-os/issues \
		-o $(POT) $$srcs && \
	grep '^\#: ' $(POT) | sed 's/^\#: //' | tr ' ' '\n' | sed 's/:.*//' | sort -u > po/POTFILES

# Install the packed zip for the current user (enable it afterwards).
install: pack
	gnome-extensions install --force $(DISTDIR)/$(UUID).shell-extension.zip

uninstall:
	gnome-extensions uninstall $(UUID)

test:
	bash tests/run.sh

lint:
	eslint .

# Strict compile into a throwaway dir; fails on schema errors and warnings.
schema-check:
	@d=$$(mktemp -d) && glib-compile-schemas --strict --dry-run schemas && \
		glib-compile-schemas --strict --targetdir="$$d" schemas; r=$$?; rm -rf "$$d"; exit $$r

check: lint schema-check css-check test

# The shelf drag-out helper is its own package (not in the extension zip): make helper-rpm
# builds dist/helper/RPMS/noarch/guava-shelf-helper-*.rpm (needs rpmbuild)
HELPER_DIR  := helpers/guava-shelf-helper
HELPER_NAME := guava-shelf-helper
HELPER_VER  := $(shell sed -n 's/^Version:[[:space:]]*//p' $(HELPER_DIR)/$(HELPER_NAME).spec)
HELPER_TOP  := $(CURDIR)/$(DISTDIR)/helper

helper-rpm:
	rm -rf $(HELPER_TOP)
	mkdir -p $(HELPER_TOP)/SOURCES $(HELPER_TOP)/stage/$(HELPER_NAME)-$(HELPER_VER)
	cp $(HELPER_DIR)/guava-shelf-helper.js $(HELPER_DIR)/org.guava.ShelfHelper.desktop \
		$(HELPER_TOP)/stage/$(HELPER_NAME)-$(HELPER_VER)/
	tar -C $(HELPER_TOP)/stage -czf $(HELPER_TOP)/SOURCES/$(HELPER_NAME)-$(HELPER_VER).tar.gz $(HELPER_NAME)-$(HELPER_VER)
	rpmbuild -bb --define "_topdir $(HELPER_TOP)" --define "dist %{nil}" $(HELPER_DIR)/$(HELPER_NAME).spec
	@ls $(HELPER_TOP)/RPMS/*/*.rpm

# Install the same files for the current user (no root): ~/.local/bin and ~/.local/share/applications
helper-install:
	install -Dm0755 $(HELPER_DIR)/guava-shelf-helper.js $(HOME)/.local/bin/guava-shelf-helper
	install -Dm0644 $(HELPER_DIR)/org.guava.ShelfHelper.desktop $(HOME)/.local/share/applications/org.guava.ShelfHelper.desktop

clean:
	rm -rf $(DISTDIR)

# Headless Shell smoke test (needs gnome-shell + dbus; not part of CI). make smoke TOGGLES=20
smoke:
	tools/smoke/run-headless.sh $(TOGGLES)
