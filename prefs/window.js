// SPDX-License-Identifier: GPL-3.0-or-later
// The preferences window shell: a sidebar of pages under section headings, beside the page
// itself, with a search over every row of every page. The pages come from prefs/pages/.
// Adw/Gtk only (the prefs process).

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

// Lower case without accents or markup, for search matching
function normalize(text) {
    return String(text ?? '').replace(/<[^>]*>/g, '').normalize('NFD')
        .replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Every titled, visible row on these pages, with the expanders it is folded in
// and the page and group it sits in. Pages match on their own title too.
function buildSearchIndex(pages, _) {
    const index = [];
    const walk = (widget, ctx) => {
        for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
            if (!child.visible)
                continue;
            let next = ctx;
            if (child instanceof Adw.PreferencesGroup && child.title)
                next = { ...ctx, group: child.title };
            if (child instanceof Adw.PreferencesRow && child.title) {
                const subtitle = child.subtitle ?? '';
                index.push({
                    row: child,
                    page: ctx.page,
                    expanders: ctx.expanders,
                    title: child.title.replace(/<[^>]*>/g, ''),
                    crumb: [ctx.page.title, next.group].filter((t, i, all) => t && all.indexOf(t) === i).join(' › '),
                    haystack: normalize(`${child.title} ${subtitle}`),
                });
            }
            if (child instanceof Adw.ExpanderRow)
                next = { ...next, expanders: [...next.expanders, child] };
            walk(child, next);
        }
    };
    for (const page of pages) {
        index.push({ row: null, page, expanders: [], title: page.title, crumb: _('Page'), haystack: normalize(page.title) });
        walk(page, { page, group: null, expanders: [] });
    }
    return index;
}

/**
 * Put the pages in a sidebar list with section headings, beside the page
 * itself. Narrow windows collapse it to a stack: the list first, then the
 * page with a back button. Labels wrap rather than squeeze, so every page
 * name stays readable at any width. The search in the sidebar finds rows on
 * every page, including those folded inside expanders.
 *
 * The shell hands us an Adw.PreferencesWindow and then checks that it has a
 * visible page, so one stays in its own (now hidden) stack.
 *
 * @param {Adw.PreferencesWindow} window the window to fill
 * @param {object} args sections ({title, pages}), breakpoints for the page area, window title
 */
export function buildNavigation(window, { sections, pageBreakpoints, title, _ }) {
    const stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE });
    // Measures the page area, so a page reflows when the sidebar takes room
    const pageBin = new Adw.BreakpointBin({ width_request: 300, height_request: 240, child: stack });
    pageBreakpoints.forEach(bp => pageBin.add_breakpoint(bp));

    const pageTitle = new Adw.WindowTitle({ title });
    const contentHeader = new Adw.HeaderBar({ title_widget: pageTitle });
    const contentView = new Adw.ToolbarView({ content: pageBin });
    contentView.add_top_bar(contentHeader);
    const contentPage = new Adw.NavigationPage({ title, tag: 'page', child: contentView });

    // Sidebar: one row per page, a heading over the first row of each section
    const navList = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE });
    navList.add_css_class('navigation-sidebar');
    const rowPage = new Map();
    const pageRow = new Map();
    const rowHeading = new Map();
    for (const section of sections) {
        section.pages.forEach((page, i) => {
            const row = sidebarRow(page.icon_name, page.title);
            navList.append(row);
            stack.add_child(page);
            rowPage.set(row, page);
            pageRow.set(page, row);
            if (i === 0)
                rowHeading.set(row, section.title);
        });
    }
    navList.set_header_func((row, before) => {
        const heading = rowHeading.get(row);
        row.set_header(heading ? sidebarHeading(heading, !before) : null);
    });

    const split = new Adw.NavigationSplitView({
        min_sidebar_width: 220,
        max_sidebar_width: 280,
        sidebar_width_fraction: 0.28,
        content: contentPage,
    });

    const showPage = (page) => {
        stack.visible_child = page;
        pageTitle.title = page.title;
        contentPage.title = page.title;
    };
    navList.connect('row-selected', (_list, row) => {
        if (row)
            showPage(rowPage.get(row));
    });
    navList.connect('row-activated', () => {
        split.show_content = true;
    });

    // Search
    const searchEntry = new Gtk.SearchEntry({
        placeholder_text: _('Search preferences'),
        hexpand: true,
    });
    const searchBar = new Gtk.SearchBar({ child: searchEntry, key_capture_widget: window });
    searchBar.connect_entry(searchEntry);
    const searchButton = new Gtk.ToggleButton({
        icon_name: 'system-search-symbolic',
        tooltip_text: _('Search'),
    });
    searchButton.bind_property('active', searchBar, 'search-mode-enabled',
        GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.SYNC_CREATE);

    const resultList = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
    resultList.add_css_class('navigation-sidebar');
    const noResults = new Adw.StatusPage({
        icon_name: 'system-search-symbolic',
        title: _('No Results Found'),
        description: _('Try a different search'),
    });
    noResults.add_css_class('compact');

    const sideStack = new Gtk.Stack();
    sideStack.add_named(new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER, child: navList, vexpand: true,
    }), 'pages');
    sideStack.add_named(new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER, child: resultList, vexpand: true,
    }), 'results');
    sideStack.add_named(noResults, 'empty');

    const sideHeader = new Adw.HeaderBar({ title_widget: new Adw.WindowTitle({ title }) });
    sideHeader.pack_end(searchButton);
    const sideView = new Adw.ToolbarView({ content: sideStack });
    sideView.add_top_bar(sideHeader);
    sideView.add_top_bar(searchBar);
    split.sidebar = new Adw.NavigationPage({ title, tag: 'sidebar', child: sideView });

    let index = [];
    let resultMap = new Map();
    let focusId = 0;

    const runSearch = () => {
        const terms = normalize(searchEntry.text).split(/\s+/).filter(Boolean);
        resultList.remove_all();
        resultMap = new Map();
        if (!searchBar.search_mode_enabled || terms.length === 0) {
            sideStack.visible_child_name = 'pages';
            return;
        }
        const hits = index.filter(item => terms.every(t => item.haystack.includes(t))).slice(0, 60);
        for (const hit of hits) {
            const row = resultRow(hit.title, hit.crumb);
            resultList.append(row);
            resultMap.set(row, hit);
        }
        sideStack.visible_child_name = hits.length ? 'results' : 'empty';
    };

    searchBar.connect('notify::search-mode-enabled', () => {
        if (searchBar.search_mode_enabled) {
            // Rebuilt each time: some rows are added or shown later
            index = buildSearchIndex([...rowPage.values()], _);
            if (split.collapsed)
                split.show_content = false;
        } else {
            searchEntry.text = '';
        }
        runSearch();
    });
    searchEntry.connect('search-changed', () => {
        if (split.collapsed && searchEntry.text)
            split.show_content = false;
        runSearch();
    });

    resultList.connect('row-activated', (_list, row) => {
        const hit = resultMap.get(row);
        if (!hit)
            return;
        navList.select_row(pageRow.get(hit.page));
        hit.expanders.forEach((expander) => {
            expander.expanded = true;
        });
        split.show_content = true;
        if (!hit.row)
            return;
        // After the expander has opened; focusing scrolls the row into view
        if (focusId)
            GLib.Source.remove(focusId);
        focusId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            focusId = 0;
            hit.row.grab_focus();
            return GLib.SOURCE_REMOVE;
        });
    });
    window.connect('close-request', () => {
        if (focusId)
            GLib.Source.remove(focusId);
        focusId = 0;
    });

    const shortcuts = new Gtk.ShortcutController();
    shortcuts.add_shortcut(new Gtk.Shortcut({
        trigger: Gtk.ShortcutTrigger.parse_string('<Control>f'),
        action: Gtk.CallbackAction.new(() => {
            searchBar.search_mode_enabled = true;
            searchEntry.grab_focus();
            return true;
        }),
    }));
    window.add_controller(shortcuts);

    // Narrow windows: a stack (list, then page) instead of side by side
    const collapse = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse('max-width: 640sp') });
    collapse.add_setter(split, 'collapsed', true);
    window.add_breakpoint(collapse);

    const first = navList.get_row_at_index(0);
    navList.select_row(first);

    // The shell asks the window for a visible page after this returns; keep
    // the stock content alive with one empty page in it, then show ours.
    window._guavaStockContent = window.get_content();
    window.add(new Adw.PreferencesPage({ title }));
    window.width_request = 360;
    window.height_request = 300;
    window.set_content(split);
}

function sidebarRow(iconName, label) {
    const box = new Gtk.Box({ spacing: 12, margin_top: 2, margin_bottom: 2 });
    if (iconName)
        box.append(new Gtk.Image({ icon_name: iconName }));
    box.append(new Gtk.Label({
        label,
        xalign: 0,
        hexpand: true,
        wrap: true,
        wrap_mode: Pango.WrapMode.WORD_CHAR,
    }));
    return new Gtk.ListBoxRow({ child: box });
}

function sidebarHeading(text, isFirst) {
    const label = new Gtk.Label({
        label: text,
        xalign: 0,
        wrap: true,
        margin_start: 12,
        margin_end: 12,
        margin_top: isFirst ? 6 : 18,
        margin_bottom: 6,
    });
    label.add_css_class('guava-sidebar-heading');
    label.add_css_class('dim-label');
    return label;
}

function resultRow(title, crumb) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        margin_top: 4,
        margin_bottom: 4,
    });
    box.append(new Gtk.Label({ label: title, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR }));
    const crumbLabel = new Gtk.Label({ label: crumb, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR });
    crumbLabel.add_css_class('caption');
    crumbLabel.add_css_class('dim-label');
    box.append(crumbLabel);
    return new Gtk.ListBoxRow({ child: box });
}
