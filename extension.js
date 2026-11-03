// Belgian Radio – GNOME Shell 51 panel menu.
//
// The panel menu only shows the UI; playback happens in player.js, which
// runs as its own process and also provides the MPRIS interface (media keys
// and the media card in the notification menu).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

const BUS_NAME = 'org.mpris.MediaPlayer2.BelgianRadio';
const CONTROL_PATH = '/be/belgianradio/Control';
const DESKTOP_ID = 'belgian-radio.desktop';

const CONTROL_XML = `
<node>
  <interface name="be.belgianradio.Control">
    <method name="PlayStation"><arg direction="in" name="Index" type="i"/></method>
    <method name="Play"/>
    <method name="Stop"/>
    <method name="Toggle"/>
    <method name="SetVolume"><arg direction="in" name="Volume" type="d"/></method>
    <property name="Stations" type="as" access="read"/>
    <property name="Station" type="i" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="ArtUrl" type="s" access="read"/>
    <property name="Volume" type="d" access="read"/>
  </interface>
</node>`;
const ControlProxy = Gio.DBusProxy.makeProxyWrapper(CONTROL_XML);

const STATUS_TEXT = {
    Stopped: 'Stopped',
    SkippingAd: 'Skipping ad…',
    Connecting: 'Connecting…',
    Buffering: 'Buffering…',
    Reconnecting: 'Reconnecting…',
    Playing: '',
};

function volumeIconName(value) {
    if (value <= 0)
        return 'audio-volume-muted-symbolic';
    if (value < 0.34)
        return 'audio-volume-low-symbolic';
    if (value < 0.67)
        return 'audio-volume-medium-symbolic';
    return 'audio-volume-high-symbolic';
}

// A hidden .desktop file gives the media card in the notification menu its
// name and logo (GNOME looks the MPRIS DesktopEntry up as an app). The logo
// is installed into the user's icon theme and referenced by name.
const ICON_NAME = 'belgian-radio';

function desktopFilePath() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'applications', DESKTOP_ID]);
}

function themeIconPath() {
    return GLib.build_filenamev([GLib.get_user_data_dir(),
        'icons', 'hicolor', '128x128', 'apps', `${ICON_NAME}.png`]);
}

// The card header forces symbolic icons, so it asks for "<name>-symbolic".
function themeSymbolicIconPath() {
    return GLib.build_filenamev([GLib.get_user_data_dir(),
        'icons', 'hicolor', 'symbolic', 'apps', `${ICON_NAME}-symbolic.svg`]);
}

function writeIfChanged(path, contents) {
    try {
        const [, old] = GLib.file_get_contents(path);
        if (old.length === contents.length && old.every((b, i) => b === contents[i]))
            return;
    } catch {}
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, contents);
}

function installDesktopFile(extensionDir) {
    try {
        const [, png] = GLib.file_get_contents(
            GLib.build_filenamev([extensionDir, 'icons', 'app.png']));
        writeIfChanged(themeIconPath(), png);
        const [, svg] = GLib.file_get_contents(
            GLib.build_filenamev([extensionDir, 'icons', `${ICON_NAME}-symbolic.svg`]));
        writeIfChanged(themeSymbolicIconPath(), svg);
        writeIfChanged(desktopFilePath(), new TextEncoder().encode([
            '[Desktop Entry]',
            'Type=Application',
            'Name=Belgian Radio',
            'Comment=Radio player in the top bar',
            `Icon=${ICON_NAME}`,
            'Exec=true',
            'NoDisplay=true',
            'StartupNotify=false',
            'Terminal=false',
            '',
        ].join('\n')));
    } catch (e) {
        console.warn(`Belgian Radio: could not install desktop entry: ${e.message}`);
    }
}

function removeDesktopFile() {
    for (const path of [desktopFilePath(), themeIconPath(), themeSymbolicIconPath()]) {
        try {
            Gio.File.new_for_path(path).delete(null);
        } catch {}
    }
}

// Runs player.js and restarts it if it dies unexpectedly.
class PlayerProcess {
    constructor(dir) {
        this._dir = dir;
        this._proc = null;
        this._restartId = 0;
        this._failures = 0;
        this._stopped = false;
        this.error = null;
    }

    start() {
        const gjs = GLib.find_program_in_path('gjs') ??
            GLib.find_program_in_path('gjs-console');
        if (!gjs) {
            this.error = 'The "gjs" program is not installed';
            return;
        }

        const launcher = new Gio.SubprocessLauncher({
            // stdin stays open while we live; the player exits on EOF.
            flags: Gio.SubprocessFlags.STDIN_PIPE,
        });
        launcher.setenv('PULSE_PROP', 'media.role=music application.icon_name=audio-x-generic', true);
        launcher.setenv('PIPEWIRE_PROPS', '{ media.role = Music }', true);

        const startedAt = GLib.get_monotonic_time();
        try {
            this._proc = launcher.spawnv([
                gjs, '-m',
                GLib.build_filenamev([this._dir, 'player.js']),
                '--watch-stdin',
                GLib.build_filenamev([this._dir, 'stations.json']),
            ]);
        } catch (e) {
            this.error = e.message;
            return;
        }
        this.error = null;

        const proc = this._proc;
        proc.wait_async(null, () => {
            if (this._stopped || proc !== this._proc)
                return;
            this._proc = null;
            // Ran for a while? Then it was a one-off crash; reset backoff.
            if (GLib.get_monotonic_time() - startedAt > 60 * GLib.USEC_PER_SEC)
                this._failures = 0;
            const delay = Math.min(60, 2 ** this._failures++);
            console.warn(`Belgian Radio: player exited, restarting in ${delay}s`);
            this._restartId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
                this._restartId = 0;
                this.start();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    stop() {
        this._stopped = true;
        if (this._restartId) {
            GLib.source_remove(this._restartId);
            this._restartId = 0;
        }
        this._proc?.send_signal(15 /* SIGTERM */);
        this._proc = null;
    }
}

const RadioIndicator = GObject.registerClass(
class RadioIndicator extends PanelMenu.Button {
    _init(player, dir) {
        super._init(0.5, 'Belgian Radio');
        this.add_style_class_name('belgian-radio-button');

        this._player = player;
        this._proxy = null;
        this._stationNames = [];
        this._stationItems = [];
        this._syncingSlider = false;
        this._dragging = false;
        this._artUrl = null;

        const icon = name => new Gio.FileIcon({
            file: Gio.File.new_for_path(GLib.build_filenamev([dir, 'icons', name])),
        });
        this._iconOn = icon('radio-on.png');
        this._iconOff = icon('radio-off.png');
        this._icon = new St.Icon({
            gicon: this._iconOff,
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._buildMenu();

        // Scroll on the top-bar icon (menu closed) changes the radio volume.
        this.connect('scroll-event', (_actor, event) => this._onScroll(event));

        this._cancellable = new Gio.Cancellable();
        new ControlProxy(Gio.DBus.session, BUS_NAME, CONTROL_PATH,
            (proxy, error) => {
                if (error) {
                    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error(`Belgian Radio: ${error.message}`);
                    return;
                }
                this._proxy = proxy;
                proxy.connectObject(
                    'g-properties-changed', () => this._sync(),
                    'notify::g-name-owner', () => this._sync(),
                    this);
                this._sync();
            },
            this._cancellable,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START);

        this._sync();
    }

    _buildMenu() {
        // Fixed width, so long song titles don't resize the menu.
        this.menu.box.add_style_class_name('belgian-radio-menu');

        // Now playing: album art + station + song
        this._nowItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._art = new St.Icon({
            icon_size: 48,
            style_class: 'belgian-radio-art',
        });
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'belgian-radio-now',
        });
        this._stationLabel = new St.Label({style_class: 'belgian-radio-station', x_expand: true});
        this._titleLabel = new St.Label({style_class: 'belgian-radio-title', x_expand: true});
        box.add_child(this._stationLabel);
        box.add_child(this._titleLabel);
        this._nowItem.add_child(this._art);
        this._nowItem.add_child(box);

        // Play / stop, at the right of the now-playing row
        this._toggleButton = new St.Button({
            icon_name: 'media-playback-start-symbolic',
            accessible_name: 'Play',
            style_class: 'icon-button belgian-radio-toggle',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._toggleButton.connect('clicked', () => {
            this._proxy?.ToggleAsync().catch(logError);
        });
        this._nowItem.add_child(this._toggleButton);
        this.menu.addMenuItem(this._nowItem);

        // Volume (only this radio's stream; the volume keys stay system-wide)
        this._volumeItem = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            can_focus: false,
        });
        this._volumeIcon = new St.Icon({
            icon_name: 'audio-volume-medium-symbolic',
            style_class: 'popup-menu-icon',
        });
        this._slider = new Slider(0.5);
        this._slider.accessible_name = 'Radio volume';
        this._slider.connect('notify::value', () => {
            this._volumeIcon.icon_name = volumeIconName(this._slider.value);
            if (!this._syncingSlider)
                this._proxy?.SetVolumeAsync(this._slider.value).catch(logError);
        });
        this._slider.connect('drag-begin', () => {
            this._dragging = true;
        });
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            this._sync();
        });
        this._volumeItem.add_child(this._volumeIcon);
        this._volumeItem.add_child(this._slider);
        this.menu.addMenuItem(this._volumeItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._stationSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._stationSection);
    }

    _onScroll(event) {
        if (this.menu.isOpen || !this._proxy?.g_name_owner)
            return Clutter.EVENT_PROPAGATE;
        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            delta = 1;
            break;
        case Clutter.ScrollDirection.DOWN:
            delta = -1;
            break;
        case Clutter.ScrollDirection.SMOOTH:
            delta = -event.get_scroll_delta()[1];
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        // 5 % per wheel click (the slider's own step is 2 %).
        this._slider.step(delta * 2.5);
        Main.osdWindowManager.showAll(
            new Gio.ThemedIcon({name: volumeIconName(this._slider.value)}),
            'Radio', this._slider.value, 1);
        return Clutter.EVENT_STOP;
    }

    _rebuildStations(names) {
        if (names.join('\n') === this._stationNames.join('\n'))
            return;
        this._stationNames = names;
        this._stationSection.removeAll();
        this._stationItems = names.map((name, index) => {
            const item = new PopupMenu.PopupMenuItem(name);
            item.connect('activate', () => {
                this._proxy?.PlayStationAsync(index).catch(logError);
            });
            this._stationSection.addMenuItem(item);
            return item;
        });
    }

    _setArt(url) {
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        this._art.gicon = url
            ? new Gio.FileIcon({file: Gio.File.new_for_uri(url)})
            : new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
    }

    _sync() {
        const proxy = this._proxy;
        const online = !!proxy?.g_name_owner;

        this._toggleButton.reactive = online;
        this._toggleButton.can_focus = online;
        this._volumeItem.setSensitive(online);
        this._slider.reactive = online;

        if (!online) {
            this._stationLabel.text = 'Belgian Radio';
            this._titleLabel.text = this._player.error ?? 'Starting player…';
            this._titleLabel.visible = true;
            this._icon.gicon = this._iconOff;
            this._setArt(null);
            for (const item of this._stationItems)
                item.setSensitive(false);
            return;
        }

        const names = proxy.Stations ?? [];
        const index = proxy.Station ?? 0;
        const status = proxy.Status ?? 'Stopped';
        const title = proxy.Title ?? '';
        const volume = proxy.Volume ?? 0.5;
        const active = status !== 'Stopped';

        this._rebuildStations(names);
        this._stationItems.forEach((item, i) => {
            item.setSensitive(true);
            item.setOrnament(i === index
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        });

        this._stationLabel.text = names[index] ?? 'Belgian Radio';
        this._titleLabel.text = (status === 'Playing' ? title : STATUS_TEXT[status]) ?? '';
        this._titleLabel.visible = this._titleLabel.text !== '';
        this._setArt(proxy.ArtUrl || null);

        this._toggleButton.accessible_name = active ? 'Stop' : 'Play';
        this._toggleButton.icon_name = active
            ? 'media-playback-stop-symbolic' : 'media-playback-start-symbolic';

        // radiotray-ng style: white tower while playing, grey when stopped.
        this._icon.gicon = active ? this._iconOn : this._iconOff;

        if (!this._dragging && Math.abs(this._slider.value - volume) > 0.001) {
            this._syncingSlider = true;
            this._slider.value = volume;
            this._syncingSlider = false;
        }
        this._volumeIcon.icon_name = volumeIconName(this._slider.value);
    }

    destroy() {
        this._cancellable.cancel();
        this._proxy?.disconnectObject(this);
        this._proxy = null;
        super.destroy();
    }
});

export default class BelgianRadioExtension extends Extension {
    enable() {
        installDesktopFile(this.path);

        this._player = new PlayerProcess(this.path);
        this._player.start();

        this._indicator = new RadioIndicator(this._player, this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // We stay enabled on the lock screen so the radio keeps playing,
        // but the panel menu is hidden there.
        Main.sessionMode.connectObject('updated', () => this._syncSessionMode(), this);
        this._syncSessionMode();
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        this._indicator?.destroy();
        this._indicator = null;
        this._player?.stop();
        this._player = null;
        removeDesktopFile();
    }

    _syncSessionMode() {
        if (this._indicator)
            this._indicator.visible = !Main.sessionMode.isLocked;
    }
}
