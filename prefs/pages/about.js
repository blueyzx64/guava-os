// SPDX-License-Identifier: GPL-3.0-or-later
// About: the project, its links, the author's other work and extensions that work with Guava.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import * as onboardingPrefs from '../../features/onboarding/prefs.js';
import { addFeatureGroups, linkRow } from '../widgets.js';

export const PAGE = { id: 'about', icon: 'help-about-symbolic' };

export function build({ settings, extension, window, _, breakpoints, title: extensionTitle }) {
    const page = new Adw.PreferencesPage({ title: _('About'), icon_name: PAGE.icon });

    // Header group with centered logo, title, author, and version
    const headerGroup = new Adw.PreferencesGroup();
    const headerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 16,
        margin_bottom: 8,
        margin_start: 16,
        margin_end: 16,
        halign: Gtk.Align.CENTER,
    });

    // Logo centered — Gtk.Picture scales with the window (matches guava-menu)
    headerBox.append(new Gtk.Picture({
        file: Gio.File.new_for_path(`${extension.path}/icons/guava_logo.png`),
        width_request: 128,
        height_request: 128,
        content_fit: Gtk.ContentFit.CONTAIN,
        halign: Gtk.Align.CENTER,
    }));

    // Title
    const titleLabel = new Gtk.Label({
        label: `<span size="xx-large" weight="bold">${GLib.markup_escape_text(extensionTitle, -1)}</span>`,
        use_markup: true,
        halign: Gtk.Align.CENTER,
    });
    headerBox.append(titleLabel);

    // Author
    const authorLabel = new Gtk.Label({
        label: 'blueyzx64 · based on Kiwi by Arnis Kemlers (kem-a)',
        halign: Gtk.Align.CENTER,
    });
    headerBox.append(authorLabel);

    // Version pill
    // EGO adds the numeric version on upload; local installs only have version-name
    const versionName = extension.metadata['version-name'];
    const version = extension.metadata.version;
    const versionButton = new Gtk.Button({
        label: version ? `${versionName} (${version})` : versionName,
        halign: Gtk.Align.CENTER,
        margin_top: 4,
        tooltip_text: _('Change log'),
    });
    versionButton.add_css_class('pill');
    versionButton.add_css_class('guava-version-button');
    versionButton.connect('clicked', () => {
        Gtk.show_uri(null, `https://github.com/blueyzx64/guava-is-not-apple/releases/tag/v${encodeURIComponent(versionName)}`, Gdk.CURRENT_TIME);
    });
    headerBox.append(versionButton);

    headerGroup.add(headerBox);
    page.add(headerGroup);
    addFeatureGroups(page, onboardingPrefs, { extension, window, _, settings });

    // Content group: the link cards
    const contentGroup = new Adw.PreferencesGroup();
    const contentBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 24,
        margin_top: 8,
        margin_bottom: 16,
        margin_start: 16,
        margin_end: 16,
        hexpand: true,
        homogeneous: true,
    });

    // Left column: link groups styled with ActionRows
    const leftColumn = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        hexpand: true,
        halign: Gtk.Align.FILL,
    });

    // Separate cards: Website and Report an Issue
    const websiteCard = new Adw.PreferencesGroup();
    websiteCard.add(linkRow(_('Website'), 'https://github.com/blueyzx64/guava-is-not-apple'));
    leftColumn.append(websiteCard);

    const issueCard = new Adw.PreferencesGroup();
    issueCard.add(linkRow(_('Report an Issue'), 'https://github.com/blueyzx64/guava-is-not-apple/issues'));
    leftColumn.append(issueCard);

    // Combined Credits & Legal group
    const infoGroup = new Adw.PreferencesGroup();
    infoGroup.add(linkRow(_('Credits'), 'https://github.com/blueyzx64/guava-is-not-apple#credits'));

    const legalRow = new Adw.ActionRow({
        title: _('Legal'),
        activatable: true,
    });
    legalRow.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic' }));
    legalRow.connect('activated', () => {
        // Create a dialog with slide-up presentation
        const legalDialog = new Adw.Dialog({
            content_width: 420,
            content_height: 560,
            presentation_mode: Adw.DialogPresentationMode.BOTTOM_SHEET,
        });

        const legalToolbar = new Adw.ToolbarView();
        const legalHeader = new Adw.HeaderBar({
            show_title: true,
            title_widget: new Adw.WindowTitle({ title: _('Legal') }),
        });
        legalToolbar.add_top_bar(legalHeader);

        const legalContent = new Adw.PreferencesPage();

        // License section
        const licenseGroup = new Adw.PreferencesGroup({
            title: _('License'),
            description: _('Guava is free and open source software'),
        });

        // GPL License link
        licenseGroup.add(linkRow(
            _('GNU General Public License v3.0'),
            'https://github.com/blueyzx64/guava-is-not-apple/blob/main/LICENSE',
            _('View the full license text on GitHub')
        ));

        legalContent.add(licenseGroup);

        // Copyright section
        const copyrightGroup = new Adw.PreferencesGroup({
            title: _('Copyright'),
            description: `${_('Copyright')} © 2025 Arnis Kemlers\n${_('Copyright')} © 2026 blueyzx64\n\n${_('This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.')}`,
        });
        legalContent.add(copyrightGroup);

        const scroller = new Gtk.ScrolledWindow({ vexpand: true, hexpand: true });
        scroller.set_child(legalContent);
        legalToolbar.set_content(scroller);
        legalDialog.set_child(legalToolbar);

        // Present the dialog
        legalDialog.present(window);
    });
    infoGroup.add(legalRow);

    leftColumn.append(infoGroup);

    contentBox.append(leftColumn);


    contentGroup.add(contentBox);
    page.add(contentGroup);

    // Responsive breakpoint: stack columns vertically when window is narrow.
    const aboutBreakpoint = new Adw.Breakpoint({
        condition: Adw.BreakpointCondition.parse('max-width: 500sp'),
    });
    aboutBreakpoint.add_setter(contentBox, 'orientation', Gtk.Orientation.VERTICAL);
    aboutBreakpoint.add_setter(contentBox, 'homogeneous', false);
    breakpoints.push(aboutBreakpoint);

    const moreGroup = new Adw.PreferencesGroup({
        title: _('More from the Kiwi author (kem-a)'),
    });

    const moreProjects = [
        { title: _('Kiwi Menu'), subtitle: _('MacOS style menu for GNOME'), url: 'https://github.com/kem-a/Kiwi-Menu' },
        { title: _('AppManager'), subtitle: _('MacOS style AppImage installer and management application'), url: 'https://github.com/kem-a/AppManager' },
        { title: _('Catalina Reloaded Icon Pack'), subtitle: _('macOS Tahoe icon theme for Linux'), url: 'https://github.com/kem-a/Catalina-reloaded' },
        { title: _('GDM Wallpaper'), subtitle: _('Set custom GDM login screen wallpaper'), url: 'https://github.com/kem-a/gnome-gdm-wallpaper' },
    ];

    moreProjects.forEach((project) => {
        moreGroup.add(linkRow(project.title, project.url, project.subtitle));
    });
    page.add(moreGroup);

    const recommendedGroup = new Adw.PreferencesGroup();
    page.add(recommendedGroup);

    const recommendedExpander = new Adw.ExpanderRow({
        title: _('Other Recommended Extensions'),
        subtitle: _('Extensions that are compatible with Guava'),
        expanded: false,
    });
    recommendedGroup.add(recommendedExpander);

    const recommendedExtensions = [
        { title: 'Superbar', author: 'Furkan-rgb', url: 'https://github.com/Furkan-rgb/superbar' },
        { title: 'Compiz alike magic lamp effect', author: 'hermes83', url: 'https://extensions.gnome.org/extension/3740/' }, 
        { title: 'AppIndicator Support', author: '3v1n0', url: 'https://extensions.gnome.org/extension/615/' },
        { title: 'Blur My Shell', author: 'aunetx', url: 'https://github.com/aunetx/blur-my-shell' },
        { title: 'Light Style', author: 'fmuellner', url: 'https://extensions.gnome.org/extension/6198/' },
        { title: 'Weather or Not', author: 'somepaulo', url: 'https://extensions.gnome.org/extension/5660/' },
    ];

    recommendedExtensions.forEach((rec) => {
        recommendedExpander.add_row(linkRow(rec.title, rec.url, rec.author));
    });


    return page;
}
