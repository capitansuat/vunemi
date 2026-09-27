# dmgbuild settings for the Vunemi disk image. make-dmg.sh passes:
#   -D app=<path to Vunemi.app>  -D background=<path to background.png>
# Icon positions must match scripts/dmg-background.swift.
import os.path

app = defines["app"]
background = defines["background"]

format = "ULFO"
filesystem = "HFS+"
files = [app]
symlinks = {"Applications": "/Applications"}

# The height includes the title bar; the background is 640 x 440.
window_rect = ((200, 160), (640, 472))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
icon_size = 112
text_size = 13
icon_locations = {
    os.path.basename(app): (170, 200),
    "Applications": (470, 200),
    # Hidden, but shown when Finder shows hidden files: keep it out of view.
    ".background.tiff": (320, 900),
}
