# Belgian Radio (GNOME Shell 51)

A panel radio player in the style of Radiotray-NG.

- Panel menu: now playing, Play/Stop, a volume slider for the radio only, and the station list.
- The current song appears in the media card in the notification menu (MPRIS). No notification banners are ever sent.
- Media keys: Play/Pause starts and stops, Next and Previous switch stations. The volume keys stay system-wide.
- Joe stations (`"skip_preroll": true`): Joe's ad server occasionally starts a new connection with a 30 s pre-roll ad, announced in the stream's first metadata block (`adw_ad='true' … insertionType='preroll'`). A background guard checks every Joe station every 5 minutes: live music means it hangs up at once, while a pending pre-roll is listened to silently, so the ad doesn't reach you. Before playback the check runs once more (about 1 s): a pre-roll there is dropped, and if it comes back it's listened to silently first ("Skipping ad…", about 20 s).
- Album art for the current song is looked up on Deezer (iTunes as fallback) and only used when artist and title really match; compilation, live and remix covers are avoided. Covers are cached in `~/.cache/belgian-radio/art`.
- During ads the stream clears its song title; the menu then shows "Ad break" instead of the previous song, and an old title repeated after the break is ignored.
- Stations are sorted alphabetically.
- Scroll on the top-bar icon (menu closed) to change the radio volume (5 % per click, with the volume pop-up).
- Playback runs outside GNOME Shell: `player.js` (a `gjs` process) handles the logic, and a hidden `mpv` plays the audio with a 10-second read-ahead cache. If the stream stalls for 10 seconds, the player reconnects by itself.
- Keeps playing while the screen is locked.

## Prerequisites

| What | Why | Arch package |
|---|---|---|
| GNOME Shell 51 (Wayland or X11) | Runs the extension; also provides the `gnome-extensions` command | `gnome-shell` |
| `gjs` | Runs the player process (`player.js`) | `gjs` |
| libsoup 3 (with its GObject introspection data) | Network access: ad check, album art | `libsoup3` |
| GLib/GIO 2.86 or newer | D-Bus (MPRIS, menu ↔ player), `GLibUnix`/`GioUnix` | `glib2` |
| `mpv` | Plays the audio (a hidden instance; your mpv config and scripts are not used) | `mpv` |
| PipeWire with its PulseAudio server, or PulseAudio | Sound output; gives the radio its own volume in GNOME's sound settings | `pipewire-pulse` |
| Internet access | The streams; album art from `api.deezer.com` (fallback `itunes.apple.com`) | – |

Install everything on Arch:

    sudo pacman -S --needed gnome-shell gjs libsoup3 glib2 mpv pipewire-pulse

Other distributions:

    # Fedora (mpv comes from RPM Fusion)
    sudo dnf install gjs libsoup3 mpv
    # Debian / Ubuntu
    sudo apt install gjs gir1.2-soup-3.0 mpv

Check that everything is there:

    gnome-shell --version; gjs --version; mpv --version | head -1; pactl info | grep "Server Name"

GStreamer is not needed.

## Install

    gnome-extensions install --force belgian-radio@local.zip

Log out and back in (Wayland), then:

    gnome-extensions enable belgian-radio@local

## Stations

Edit `stations.json` in the extension folder (Radiotray-NG bookmarks format), then disable and re-enable the extension.
Add `"skip_preroll": true` to any AdsWizz/Qmusic-style stream that starts with an ad.

## Credits

Panel icons from [Radiotray-NG](https://github.com/ebruck/radiotray-ng) (GPL-3.0).

## Troubleshooting

The player's log is in the journal:

    journalctl --user -f | grep belgian-radio

For verbose logs, run the player by hand while the extension is disabled (extra mpv options can be passed with `BELGIAN_RADIO_MPV_ARGS`, e.g. `--ao=pulse`):

    BELGIAN_RADIO_DEBUG=1 gjs -m ~/.local/share/gnome-shell/extensions/belgian-radio@local/player.js

Every pre-roll the player meets is logged (`pre-roll ad on … listened to silently` / `dropped the connection`).

Volume and last station are stored in `~/.config/belgian-radio/state.json`.
