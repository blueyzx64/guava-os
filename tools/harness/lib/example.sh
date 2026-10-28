# Example scenario (GUAVA_EXTRA): launch Text Editor, assert its window exists, take a screenshot.
# Bundle with:  bundle.sh OUT lib.sh example.sh
launch_app "gnome-text-editor" org.gnome.TextEditor 40
assert text-editor-window-exists "kwin('org.gnome.TextEditor')!==null"
shot example-text-editor
assert_summary
