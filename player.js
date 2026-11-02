// Belgian Radio – playback backend.
//
// Runs as a separate `gjs -m player.js` process started by the extension, so
// network I/O never runs inside GNOME Shell. The audio itself is played by a
// hidden mpv process that this player controls over mpv's IPC socket.
//
// It exposes:
//   * org.mpris.MediaPlayer2 + .Player   -> media keys and the media card in
//                                            the notification/calendar menu
//   * be.belgianradio.Control            -> used by the panel menu
//
// Pre-roll ads: Joe's ad server (AdsWizz) occasionally starts a new
// connection with a pre-roll ad, announced in the very first ICY metadata block:
//   StreamTitle='';adw_ad='true';durationMilliseconds='30208';insertionType='preroll';
// For stations marked "skip_preroll", a background guard regularly opens a
// connection and reads that first block: live music -> hang up at once;
// pre-roll -> listen silently until the announced length has been received.
// Whenever the server wants to play an ad, the guard gets it instead of you.
// Before playback the same check runs once more (about 1 s).

import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

Gio._promisify(Soup.Session.prototype, 'send_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');
Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');

const BUS_NAME = 'org.mpris.MediaPlayer2.BelgianRadio';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const CONTROL_PATH = '/be/belgianradio/Control';
const DESKTOP_ENTRY = 'belgian-radio';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

const PREROLL_RE = /insertionType='?preroll/i;
// Background guard: check each station this often.
const GUARD_INTERVAL = 5 * 60;
// Never listen to an ad (or wait for metadata) longer than this.
const AD_MAX_SECONDS = 120;

const ART_CACHE_MAX_FILES = 300;

// Reconnect after this long without progress (stuck buffering / stalled).
const STALL_SECONDS = 10;


const MPRIS_ROOT_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
</node>`;

const MPRIS_PLAYER_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek"><arg direction="in" name="Offset" type="x"/></method>
    <method name="SetPosition">
      <arg direction="in" name="TrackId" type="o"/>
      <arg direction="in" name="Position" type="x"/>
    </method>
    <method name="OpenUri"><arg direction="in" name="Uri" type="s"/></method>
    <signal name="Seeked"><arg name="Position" type="x"/></signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

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

const STATUS_TEXT = {
    Stopped: 'Stopped',
    SkippingAd: 'Skipping ad…',
    Connecting: 'Connecting…',
    Buffering: 'Buffering…',
    Reconnecting: 'Reconnecting…',
    Playing: 'Live',
};

const AD_BREAK_TITLE = 'Ad break';

// Lower-case, no accents/brackets/"feat." parts/punctuation, for comparing names.
function norm(s) {
    return (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/\(.*?\)|\[.*?\]/g, ' ')
        .replace(/\b(feat|ft|featuring)\b.*$/, ' ')
        .replace(/^the\s+/, '')
        .replace(/[^a-z0-9]+/g, ' ').trim();
}

function primaryArtist(artist) {
    return (artist ?? '').split(/,|&|\s+x\s+|\s+(?:and|en|feat\.?|ft\.?|featuring)\s+/i)[0];
}

function trackMatches(wantArtist, wantTitle, gotArtist, gotTitle) {
    const wa = norm(primaryArtist(wantArtist));
    const ga = norm(gotArtist);
    const wt = norm(wantTitle);
    const gt = norm(gotTitle);
    if (!wa || !wt || !ga || !gt)
        return false;
    const artistOk = ga.includes(wa) || (wa.includes(ga) && ga.length > 2);
    const titleOk = gt === wt || gt.startsWith(wt) || (wt.startsWith(gt) && gt.length > 2);
    return artistOk && titleOk;
}

// Covers of compilations, live albums and remixes are usually the wrong picture.
const UNLIKELY_COVER = /\b(hits|best of|greatest|collection|compilation|various|top ?\d+|essentials|anthology|live|remix|mix|karaoke|cover)\b/i;

const now = () => GLib.get_real_time() / 1e6;

function log(msg) {
    printerr(`belgian-radio: ${msg}`);
}

// Set BELGIAN_RADIO_DEBUG=1 for verbose logs.
const DEBUG = !!GLib.getenv('BELGIAN_RADIO_DEBUG');
function debug(msg) {
    if (DEBUG)
        log(msg);
}

const PLAYER_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);

function toUri(pathOrUrl, baseDir) {
    if (!pathOrUrl)
        return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl))
        return pathOrUrl;
    const path = GLib.path_is_absolute(pathOrUrl)
        ? pathOrUrl : GLib.build_filenamev([baseDir, pathOrUrl]);
    return GLib.filename_to_uri(path, null);
}

function loadStations(path) {
    const [, bytes] = GLib.file_get_contents(path);
    const data = JSON.parse(new TextDecoder().decode(bytes));
    const baseDir = GLib.path_get_dirname(path);
    // Accept radiotray-ng's bookmarks format (array of groups), a single
    // group object, or a bare array of stations.
    const groups = Array.isArray(data) ? data : [data];
    const stations = [];
    for (const group of groups) {
        const list = Array.isArray(group?.stations) ? group.stations : [group];
        for (const s of list) {
            if (typeof s?.url !== 'string')
                continue;
            stations.push({
                name: String(s.name ?? s.url),
                url: s.url,
                skipPreroll: s.skip_preroll === true,
                image: toUri(s.image, baseDir),
            });
        }
    }
    if (stations.length === 0)
        throw new Error(`no stations found in ${path}`);
    stations.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, {sensitivity: 'base', numeric: true}));
    return stations;
}

class StateFile {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'belgian-radio']);
        this._path = GLib.build_filenamev([this._dir, 'state.json']);
        this._saveId = 0;
    }

    load() {
        try {
            const [, bytes] = GLib.file_get_contents(this._path);
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return {};
        }
    }

    save(state) {
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 1, () => {
            this._saveId = 0;
            this.saveNow(state);
            return GLib.SOURCE_REMOVE;
        });
    }

    saveNow(state) {
        try {
            GLib.mkdir_with_parents(this._dir, 0o700);
            GLib.file_set_contents(this._path, JSON.stringify(state));
        } catch (e) {
            log(`could not save state: ${e.message}`);
        }
    }
}

function parseStreamTitle(meta) {
    const m = /StreamTitle='(.*?)';(?=[A-Za-z_]+=|\s*$)/s.exec(meta);
    return m ? m[1].trim() : null;
}

function isAdTitle(title) {
    return /^(adbreak|ad break|advertisement|reclame|preroll)$/i.test(title ?? '');
}

function isAdMeta(meta) {
    return /adw_ad='?true|insertionType='?preroll/i.test(meta) ||
        isAdTitle(parseStreamTitle(meta));
}

// Splits an ICY (shoutcast) stream into audio and metadata blocks.
class IcyReader {
    constructor(metaint, onMeta) {
        this._metaint = metaint;
        this._left = metaint;
        this._state = 'audio';
        this._buf = [];
        this._onMeta = onMeta;
        this.audioBytes = 0;
    }

    feed(data) {
        let i = 0;
        while (i < data.length) {
            if (this._state === 'audio') {
                const n = Math.min(this._left, data.length - i);
                i += n;
                this._left -= n;
                this.audioBytes += n;
                if (this._left === 0)
                    this._state = 'length';
            } else if (this._state === 'length') {
                this._left = data[i++] * 16;
                if (this._left > 0) {
                    this._state = 'meta';
                    this._buf = [];
                } else {
                    this._state = 'audio';
                    this._left = this._metaint;
                }
            } else {
                const n = Math.min(this._left, data.length - i);
                this._buf.push(...data.subarray(i, i + n));
                i += n;
                this._left -= n;
                if (this._left === 0) {
                    const raw = new Uint8Array(this._buf);
                    let text;
                    try {
                        text = new TextDecoder('utf-8', {fatal: true}).decode(raw);
                    } catch {
                        text = new TextDecoder('latin1').decode(raw);
                    }
                    text = text.replace(/\0+$/, '');
                    this._onMeta(text);
                    this._state = 'audio';
                    this._left = this._metaint;
                }
            }
        }
    }
}

// Detects pre-roll ads from the first metadata block of a connection and,
// when one is pending, listens to it silently so playback doesn't get it.
class AdGuard {
    constructor(session) {
        this._session = session;
        this._cancellable = new Gio.Cancellable();
        this._pending = new Map();   // url -> promise of a consuming check
        this._consuming = new Set(); // urls whose ad is being listened to now
    }

    // Connects to url and reads the first metadata block. Without `consume`
    // the connection is dropped right away. With `consume`, a pre-roll is
    // listened to (silently) until it has been received completely.
    // Resolves to {uri, preroll, consumed}.
    async check(url, {consume = false} = {}) {
        const started = now();
        const msg = Soup.Message.new('GET', url);
        msg.get_request_headers().append('Icy-MetaData', '1');
        const cancellable = new Gio.Cancellable();
        const parentId = this._cancellable.connect(() => cancellable.cancel());
        let timedOut = false;
        let timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, AD_MAX_SECONDS, () => {
            timerId = 0;
            timedOut = true;
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
        let stream = null;

        try {
            stream = await this._session.send_async(msg, GLib.PRIORITY_LOW, cancellable);
            const status = msg.get_status();
            if (status !== Soup.Status.OK)
                throw new Error(`HTTP ${status}`);
            const headers = msg.get_response_headers();
            const uri = msg.get_uri().to_string();
            const server = headers.get_one('X-Server') ?? '?';
            const metaint = parseInt(headers.get_one('icy-metaint') ?? '', 10);
            if (!(metaint > 0))
                return {uri, preroll: false, consumed: false};
            const bytesPerSec = (parseInt(headers.get_one('icy-br') ?? '', 10) || 96) * 1000 / 8;

            let first = null;
            let last = null;
            const icy = new IcyReader(metaint, meta => {
                first ??= meta;
                last = meta;
            });
            let preroll = false;
            let duration = 0;

            try {
                for (;;) {
                    // eslint-disable-next-line no-await-in-loop
                    const bytes = await stream.read_bytes_async(
                        16 * 1024, GLib.PRIORITY_LOW, cancellable);
                    if (bytes.get_size() === 0)
                        break;
                    icy.feed(bytes.toArray());
                    if (first === null)
                        continue;
                    preroll = PREROLL_RE.test(first);
                    if (!preroll || !consume)
                        break;
                    if (!this._consuming.has(url)) {
                        duration = (parseInt(/durationMilliseconds='?(\d+)/.exec(first)?.[1] ?? '', 10) || 30000) / 1000;
                        this._consuming.add(url);
                        debug(`pre-roll of ${duration}s on ${server} for ${url}, listening silently`);
                    }
                    // Done once the live title arrives, or the announced
                    // length (plus margin) has been received.
                    if (!PREROLL_RE.test(last) ||
                        icy.audioBytes >= (duration + 3) * bytesPerSec)
                        break;
                }
            } catch (e) {
                if (!timedOut)
                    throw e;
            }

            const secs = Math.round(now() - started);
            if (preroll) {
                log(`pre-roll ad on ${server} for ${url}: ` +
                    `${consume ? `listened to silently (${secs}s)` : 'dropped the connection'}`);
            } else {
                debug(`no pre-roll on ${server} for ${url}`);
            }
            return {uri, preroll, consumed: preroll && consume};
        } finally {
            this._consuming.delete(url);
            if (timerId)
                GLib.source_remove(timerId);
            this._cancellable.disconnect(parentId);
            stream?.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
        }
    }

    // Background guard for one station (never two at once for one url).
    guard(url) {
        let pending = this._pending.get(url);
        if (!pending) {
            pending = this.check(url, {consume: true}).finally(() => {
                this._pending.delete(url);
            });
            this._pending.set(url, pending);
        }
        return pending;
    }

    async guardAll(urls) {
        for (const url of urls) {
            try {
                // eslint-disable-next-line no-await-in-loop
                await this.guard(url);
            } catch (e) {
                if (!this._cancellable.is_cancelled())
                    log(`ad check for ${url} failed: ${e.message}`);
            }
        }
    }

    // Returns a URI to play that (as far as we can tell) starts without a
    // pre-roll. Calls onAd() when the user has to wait for one.
    async prepare(url, onAd) {
        if (this._pending.has(url)) {
            if (this._consuming.has(url))
                onAd();
            await this._pending.get(url).catch(() => {});
        }
        let r = await this.check(url);
        if (!r.preroll)
            return r.uri;
        // Dropping the ad connection may already be enough…
        onAd();
        r = await this.check(url);
        if (!r.preroll)
            return r.uri;
        // …otherwise listen to the ad silently first.
        r = await this.guard(url);
        return r.uri;
    }

    destroy() {
        this._cancellable.cancel();
    }
}

// Finds album art for "ARTIST - TITLE" and caches it on disk.
class ArtFetcher {
    constructor(session) {
        this._session = session;
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'belgian-radio', 'art']);
        GLib.mkdir_with_parents(this._dir, 0o700);
        this._misses = new Set();
        this._pruneCache();
    }

    // Search a cover for "ARTIST - TITLE"; only accepts real matches.
    async lookup(title) {
        const m = /^(.+?)\s+-\s+(.+)$/.exec(title);
        if (!m || isAdTitle(title))
            return null;
        const key = `v2|${title.toLowerCase()}`;
        if (this._misses.has(key))
            return null;
        const file = this._file(key);
        if (GLib.file_test(file, GLib.FileTest.EXISTS))
            return GLib.filename_to_uri(file, null);

        const [, artist, track] = m;
        let imageUrl = null;
        for (const find of [
            () => this._deezer(`artist:"${primaryArtist(artist)}" track:"${track}"`, artist, track),
            () => this._deezer(`${primaryArtist(artist)} ${track.replace(/\(.*?\)/g, '')}`, artist, track),
            () => this._itunes(`${primaryArtist(artist)} ${track.replace(/\(.*?\)/g, '')}`, artist, track),
        ]) {
            try {
                // eslint-disable-next-line no-await-in-loop
                imageUrl = await find();
            } catch (e) {
                debug(`art lookup failed: ${e.message}`);
            }
            if (imageUrl)
                break;
        }
        if (!imageUrl) {
            debug(`no matching album art for "${title}"`);
            this._misses.add(key);
            return null;
        }
        const bytes = await this._get(imageUrl);
        GLib.file_set_contents(file, bytes.toArray());
        return GLib.filename_to_uri(file, null);
    }

    _file(key) {
        return GLib.build_filenamev([this._dir,
            `${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, key, -1)}.jpg`]);
    }

    _best(candidates) {
        // candidates: [{ok, album, image}], keep matches, prefer real albums
        const ok = candidates.filter(c => c.ok && c.image);
        const best = ok.find(c => !UNLIKELY_COVER.test(c.album)) ?? ok[0];
        if (best)
            debug(`album art: using cover of "${best.album}"`);
        return best?.image ?? null;
    }

    async _get(url) {
        const msg = Soup.Message.new('GET', url);
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_LOW, null);
        if (msg.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${msg.get_status()} for ${url}`);
        return bytes;
    }

    async json(url) {
        const bytes = await this._get(url);
        return JSON.parse(new TextDecoder().decode(bytes.toArray()));
    }

    async _deezer(query, artist, track) {
        const data = await this.json(
            `https://api.deezer.com/search?limit=10&q=${encodeURIComponent(query)}`);
        return this._best((data?.data ?? []).map(r => ({
            ok: trackMatches(artist, track, r.artist?.name, r.title) &&
                (UNLIKELY_COVER.test(track) || !UNLIKELY_COVER.test(r.title ?? '')),
            album: r.album?.title ?? '',
            image: r.album?.cover_big,
        })));
    }

    async _itunes(query, artist, track) {
        const data = await this.json(
            `https://itunes.apple.com/search?entity=song&limit=10&term=${encodeURIComponent(query)}`);
        return this._best((data?.results ?? []).map(r => ({
            ok: trackMatches(artist, track, r.artistName, r.trackName) &&
                !/various/i.test(r.collectionArtistName ?? ''),
            album: r.collectionName ?? '',
            image: r.artworkUrl100?.replace(/\/\d+x\d+bb\./, '/600x600bb.'),
        })));
    }

    _pruneCache() {
        try {
            const dir = Gio.File.new_for_path(this._dir);
            const files = [];
            const en = dir.enumerate_children('standard::name,time::modified',
                Gio.FileQueryInfoFlags.NONE, null);
            for (let info; (info = en.next_file(null));)
                files.push([info.get_name(), info.get_attribute_uint64('time::modified')]);
            files.sort((a, b) => b[1] - a[1]);
            for (const [name] of files.slice(ART_CACHE_MAX_FILES))
                dir.get_child(name).delete(null);
        } catch (e) {
            debug(`art cache prune failed: ${e.message}`);
        }
    }
}

// Controls a hidden mpv process (audio only) over its JSON IPC socket.
// mpv reads the stream continuously into its cache, which plays these
// streams cleanly where GStreamer's playbin stuttered.
class Mpv {
    constructor(onEvent, onExit) {
        this._onEvent = onEvent;
        this._onExit = onExit;
        this._proc = null;
        this._conn = null;
        this._out = null;
        this._ready = null;
        this._cancellable = new Gio.Cancellable();
        this._socket = GLib.build_filenamev([GLib.get_user_runtime_dir(),
            `belgian-radio-mpv-${new Date().getTime()}.sock`]);
    }

    start(volume) {
        const mpv = GLib.find_program_in_path('mpv');
        if (!mpv)
            throw new Error('mpv is not installed');
        this._proc = Gio.Subprocess.new([
            mpv,
            '--no-config', '--load-scripts=no', // ignore user config/plugins
            '--idle=yes', '--no-video', '--terminal=no', '--force-window=no',
            `--input-ipc-server=${this._socket}`,
            '--audio-client-name=Belgian Radio',
            `--user-agent=${USER_AGENT}`,
            '--cache=yes', '--cache-secs=10', '--demuxer-readahead-secs=10',
            '--network-timeout=15',
            `--volume=${Math.round(volume * 100)}`,
            // Extra mpv options for troubleshooting, e.g. "--ao=pulse".
            ...(GLib.getenv('BELGIAN_RADIO_MPV_ARGS') ?? '').split(/\s+/).filter(Boolean),
        ], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        this._proc.wait_async(null, () => {
            const stillOurs = !!this._proc;
            this._proc = null;
            this._conn = null;
            this._out = null;
            if (stillOurs)
                this._onExit();
        });
        this._ready = this._connect();
        return this._ready;
    }

    async _connect() {
        const client = new Gio.SocketClient();
        const address = Gio.UnixSocketAddress.new(this._socket);
        for (let i = 0; i < 100; i++) {
            try {
                // eslint-disable-next-line no-await-in-loop
                this._conn = await client.connect_async(address, this._cancellable);
                break;
            } catch (e) {
                if (this._cancellable.is_cancelled() || !this._proc)
                    throw e;
                // eslint-disable-next-line no-await-in-loop
                await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => r() ?? false));
            }
        }
        if (!this._conn)
            throw new Error('could not connect to mpv');
        this._out = this._conn.get_output_stream();
        this._read(new Gio.DataInputStream({base_stream: this._conn.get_input_stream()}));
    }

    async _read(input) {
        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const [line] = await input.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable);
                if (line === null)
                    break;
                const text = new TextDecoder().decode(line);
                try {
                    this._onEvent(JSON.parse(text));
                } catch (e) {
                    debug(`mpv: ${e.message}: ${text}`);
                }
            }
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                debug(`mpv connection: ${e.message}`);
        }
    }

    command(...args) {
        if (!this._out)
            return;
        try {
            this._out.write_all(new TextEncoder().encode(`${JSON.stringify({command: args})}\n`), null);
        } catch (e) {
            log(`mpv command ${args[0]} failed: ${e.message}`);
        }
    }

    async whenReady() {
        await this._ready;
    }

    destroy() {
        const proc = this._proc;
        this._proc = null;
        this.command('quit');
        this._cancellable.cancel();
        if (proc) {
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
        }
        try {
            GLib.unlink(this._socket);
        } catch {}
    }
}

class RadioPlayer {
    constructor(stations) {
        this._stations = stations;
        this._stateFile = new StateFile();
        const saved = this._stateFile.load();
        const byName = stations.findIndex(s => s.name === saved.stationName);
        this._index = byName >= 0 ? byName : 0;
        this._volume = typeof saved.volume === 'number'
            ? Math.min(1, Math.max(0, saved.volume)) : 0.5;

        this._wanted = false;
        this._status = 'Stopped';
        this._title = '';
        this._artUrl = '';
        this._icyTitle = '';
        this._hadIcyTitle = false;
        this._titleBeforeBreak = '';
        this._token = 0;
        this._retries = 0;
        this._retryId = 0;
        this._loading = false;
        this._lastProgress = 0;
        this._playTime = null;
        this._quitting = false;

        this._session = new Soup.Session({
            user_agent: USER_AGENT,
            timeout: 30,
            max_conns_per_host: 16,
        });
        this._adGuard = new AdGuard(this._session);
        this._art = new ArtFetcher(this._session);
        this._defaultArt = GLib.filename_to_uri(
            GLib.build_filenamev([PLAYER_DIR, 'icons', 'cover.png']), null);

        this._startMpv();

        this._watchdogId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 1, () => {
            this._watchdog();
            return GLib.SOURCE_CONTINUE;
        });

        // Catch pending pre-rolls in the background, right away and regularly
        // (not while playing: an extra connection from this computer could
        // disturb the stream you are listening to).
        const prerollUrls = stations.filter(s => s.skipPreroll).map(s => s.url);
        if (prerollUrls.length > 0) {
            this._adGuard.guardAll(prerollUrls);
            this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, GUARD_INTERVAL, () => {
                if (!this._wanted)
                    this._adGuard.guardAll(prerollUrls);
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _startMpv() {
        this._mpv = new Mpv(event => this._onMpvEvent(event), () => {
            if (this._quitting)
                return;
            log('mpv exited, restarting it');
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                this._startMpv();
                if (this._wanted)
                    this._start().catch(e => log(`restart failed: ${e.message}`));
                return GLib.SOURCE_REMOVE;
            });
        });
        this._mpv.start(this._volume).then(() => {
            this._mpv.command('observe_property', 1, 'metadata');
            this._mpv.command('observe_property', 2, 'paused-for-cache');
            this._mpv.command('observe_property', 3, 'playback-time');
        }).catch(e => log(`mpv: ${e.message}`));
    }

    // ---- public API -------------------------------------------------------

    get stationNames() {
        return this._stations.map(s => s.name);
    }

    get index() {
        return this._index;
    }

    get status() {
        return this._status;
    }

    get title() {
        return this._title;
    }

    get artUrl() {
        return this._artUrl || this._stations[this._index].image || this._defaultArt;
    }

    get volume() {
        return this._volume;
    }

    get playbackStatus() {
        return this._wanted ? 'Playing' : 'Stopped';
    }

    get metadata() {
        const station = this._stations[this._index];
        return {
            'mpris:trackid': new GLib.Variant('o', `/be/belgianradio/station/${this._index}`),
            'xesam:title': new GLib.Variant('s', this._title || station.name),
            'xesam:artist': new GLib.Variant('as',
                [this._title ? station.name : STATUS_TEXT[this._status] ?? '']),
            'xesam:album': new GLib.Variant('s', station.name),
            'mpris:artUrl': new GLib.Variant('s', this.artUrl),
        };
    }

    play(index = this._index) {
        const n = this._stations.length;
        index = ((index % n) + n) % n;
        if (index !== this._index) {
            this._index = index;
            this._save();
            this.onChanged?.(['Station']);
        }
        this._wanted = true;
        this._retries = 0;
        this._start().catch(e => log(`start failed: ${e.message}`));
    }

    stop() {
        this._wanted = false;
        this._token++;
        this._cancelRetry();
        this._loading = false;
        this._mpv.command('stop');
        this._resetTitles();
        this._setStatus('Stopped');
    }

    toggle() {
        if (this._wanted)
            this.stop();
        else
            this.play();
    }

    next() {
        this.play(this._index + 1);
    }

    previous() {
        this.play(this._index - 1);
    }

    setVolume(volume) {
        volume = Math.min(1, Math.max(0, Number(volume) || 0));
        if (Math.abs(volume - this._volume) < 0.0005)
            return;
        this._volume = volume;
        // mpv's volume uses a cubic curve, like GNOME's sliders.
        this._mpv.command('set_property', 'volume', Math.round(volume * 1000) / 10);
        this._save();
        this.onChanged?.(['Volume']);
    }

    destroy() {
        this._quitting = true;
        this._token++;
        this._cancelRetry();
        GLib.source_remove(this._watchdogId);
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._adGuard.destroy();
        this._session.abort();
        this._mpv.destroy();
        this._stateFile.saveNow(this._stateData());
    }

    // ---- internals --------------------------------------------------------

    async _start() {
        this._cancelRetry();
        const token = ++this._token;
        this._loading = false;
        this._mpv.command('stop');
        this._resetTitles();

        const station = this._stations[this._index];
        let uri = station.url;

        if (station.skipPreroll) {
            this._setStatus('Connecting');
            try {
                uri = await this._adGuard.prepare(station.url, () => {
                    if (token === this._token)
                        this._setStatus('SkippingAd');
                });
            } catch (e) {
                log(`ad check for ${station.name} failed: ${e.message}`);
            }
            if (token !== this._token)
                return; // stopped or switched station meanwhile
        }

        await this._mpv.whenReady();
        if (token !== this._token)
            return;
        this._setStatus('Connecting');
        this._loading = true;
        this._playTime = null;
        this._lastProgress = now();
        this._mpv.command('set_property', 'volume', Math.round(this._volume * 1000) / 10);
        this._mpv.command('loadfile', uri, 'replace');
    }

    _onMpvEvent(ev) {
        if (ev.event === 'property-change') {
            switch (ev.name) {
            case 'metadata': {
                if (!this._wanted || !ev.data)
                    break;
                const md = Object.fromEntries(
                    Object.entries(ev.data).map(([k, v]) => [k.toLowerCase(), v]));
                const title = String(md['icy-title'] ?? '').trim();
                if (title || this._hadIcyTitle)
                    this._onStreamTitle(title);
                break;
            }
            case 'paused-for-cache':
                if (this._wanted && this._loading && this._status !== 'Connecting')
                    this._setStatus(ev.data ? 'Buffering' : 'Playing');
                break;
            case 'playback-time':
                if (typeof ev.data === 'number' && ev.data !== this._playTime) {
                    this._playTime = ev.data;
                    this._lastProgress = now();
                }
                break;
            }
            return;
        }

        switch (ev.event) {
        case 'playback-restart':
            if (this._wanted && this._loading) {
                this._retries = 0;
                this._lastProgress = now();
                this._setStatus('Playing');
            }
            break;
        case 'end-file':
            // 'stop' and 'redirect' come from our own loadfile/stop commands.
            if (this._wanted && this._loading && (ev.reason === 'eof' || ev.reason === 'error')) {
                log(`stream ended (${ev.reason}${ev.file_error ? `: ${ev.file_error}` : ''})`);
                this._handleFailure();
            }
            break;
        }
    }

    // Reconnect when the stream stalls (stuck buffering or not progressing).
    _watchdog() {
        if (!this._wanted || !this._loading || this._retryId)
            return;
        if (!['Playing', 'Buffering', 'Connecting'].includes(this._status))
            return;
        if (now() - this._lastProgress >= STALL_SECONDS) {
            log(`stream stalled for ${STALL_SECONDS}s (${this._status}), reconnecting`);
            this._handleFailure();
        }
    }

    _handleFailure() {
        if (!this._wanted || this._retryId)
            return;
        this._token++;
        this._loading = false;
        this._mpv.command('stop');
        this._setStatus('Reconnecting');
        const delay = Math.min(30, 2 ** this._retries++);
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._retryId = 0;
            if (this._wanted)
                this._start().catch(e => log(`restart failed: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelRetry() {
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
    }

    _setStatus(status) {
        if (status === this._status)
            return;
        this._status = status;
        this.onChanged?.(['Status']);
    }

    _resetTitles() {
        this._icyTitle = '';
        this._hadIcyTitle = false;
        this._titleBeforeBreak = '';
        this._setTitle('');
    }

    _onStreamTitle(title) {
        if (title === this._icyTitle)
            return;
        const station = this._stations[this._index];
        const wasBreak = !this._icyTitle || isAdTitle(this._icyTitle);
        if (title && !isAdTitle(title)) {
            this._hadIcyTitle = true;
            // After a break the ad server sometimes repeats the title of the
            // song before the break; that song is over, so don't show it.
            if (wasBreak && title === this._titleBeforeBreak) {
                debug(`ignoring repeated pre-break title: ${title}`);
                this._icyTitle = '';
                this._setTitle('');
                return;
            }
        } else if (this._icyTitle && !isAdTitle(this._icyTitle)) {
            this._titleBeforeBreak = this._icyTitle;
        }
        debug(`stream title: "${title}"`);
        this._icyTitle = title;
        const adBreak = isAdTitle(title) || (!title && station.skipPreroll);
        this._setTitle(adBreak ? AD_BREAK_TITLE : title);
    }

    _setTitle(title) {
        if (title === this._title)
            return;
        this._title = title;
        this._setArt('');
        this.onChanged?.(['Title']);

        if (!title || title === AD_BREAK_TITLE)
            return;
        this._art.lookup(title).then(uri => {
            if (uri && this._title === title)
                this._setArt(uri);
        }).catch(e => debug(`album art for "${title}": ${e.message}`));
    }

    _setArt(uri) {
        if (uri === this._artUrl)
            return;
        this._artUrl = uri;
        this.onChanged?.(['ArtUrl']);
    }

    _stateData() {
        return {stationName: this._stations[this._index].name, volume: this._volume};
    }

    _save() {
        this._stateFile.save(this._stateData());
    }
}

// ---- D-Bus glue -----------------------------------------------------------

function exportInterfaces(connection, player, quit) {
    const root = Gio.DBusExportedObject.wrapJSObject(MPRIS_ROOT_XML, {
        Raise() {},
        Quit() {
            quit();
        },
        get CanQuit() {
            return false;
        },
        get CanRaise() {
            return false;
        },
        get HasTrackList() {
            return false;
        },
        get Identity() {
            return 'Belgian Radio';
        },
        get DesktopEntry() {
            return DESKTOP_ENTRY;
        },
        get SupportedUriSchemes() {
            return [];
        },
        get SupportedMimeTypes() {
            return [];
        },
    });

    const mpris = Gio.DBusExportedObject.wrapJSObject(MPRIS_PLAYER_XML, {
        // "Next song" switches station; pause means stop for live radio.
        Next: () => player.next(),
        Previous: () => player.previous(),
        Pause: () => player.stop(),
        PlayPause: () => player.toggle(),
        Stop: () => player.stop(),
        Play: () => player.play(),
        Seek() {},
        SetPosition() {},
        OpenUri() {},
        get PlaybackStatus() {
            return player.playbackStatus;
        },
        get Rate() {
            return 1.0;
        },
        set Rate(_v) {},
        get Metadata() {
            return player.metadata;
        },
        get Volume() {
            return player.volume;
        },
        set Volume(v) {
            player.setVolume(v);
        },
        get Position() {
            return 0;
        },
        get MinimumRate() {
            return 1.0;
        },
        get MaximumRate() {
            return 1.0;
        },
        get CanGoNext() {
            return true;
        },
        get CanGoPrevious() {
            return true;
        },
        get CanPlay() {
            return true;
        },
        get CanPause() {
            return true;
        },
        get CanSeek() {
            return false;
        },
        get CanControl() {
            return true;
        },
    });

    const control = Gio.DBusExportedObject.wrapJSObject(CONTROL_XML, {
        PlayStation: index => player.play(index),
        Play: () => player.play(),
        Stop: () => player.stop(),
        Toggle: () => player.toggle(),
        SetVolume: volume => player.setVolume(volume),
        get Stations() {
            return player.stationNames;
        },
        get Station() {
            return player.index;
        },
        get Status() {
            return player.status;
        },
        get Title() {
            return player.title;
        },
        get ArtUrl() {
            return player.artUrl;
        },
        get Volume() {
            return player.volume;
        },
    });

    const controlValue = {
        Status: () => new GLib.Variant('s', player.status),
        Title: () => new GLib.Variant('s', player.title),
        Station: () => new GLib.Variant('i', player.index),
        Volume: () => new GLib.Variant('d', player.volume),
        ArtUrl: () => new GLib.Variant('s', player.artUrl),
    };

    player.onChanged = props => {
        const mprisChanges = new Set(['Metadata']);
        for (const prop of props) {
            control.emit_property_changed(prop, controlValue[prop]());
            if (prop === 'Station')
                control.emit_property_changed('ArtUrl', controlValue.ArtUrl());
            if (prop === 'Status')
                mprisChanges.add('PlaybackStatus');
            if (prop === 'Volume')
                mprisChanges.add('Volume');
        }
        for (const prop of mprisChanges) {
            const value = {
                Metadata: () => new GLib.Variant('a{sv}', player.metadata),
                PlaybackStatus: () => new GLib.Variant('s', player.playbackStatus),
                Volume: () => new GLib.Variant('d', player.volume),
            }[prop]();
            mpris.emit_property_changed(prop, value);
        }
    };

    root.export(connection, MPRIS_PATH);
    mpris.export(connection, MPRIS_PATH);
    control.export(connection, CONTROL_PATH);

    return () => {
        root.unexport();
        mpris.unexport();
        control.unexport();
    };
}

// ---- main -----------------------------------------------------------------
// Note: no top-level `await` in this module. It would make loop.run() execute
// inside a promise job, and GJS would then never resolve later promises.

GLib.set_prgname('belgian-radio');
GLib.set_application_name('Belgian Radio');
const args = System.programArgs;
const watchStdin = args.includes('--watch-stdin');
const stationsPath = args.find(a => !a.startsWith('--')) ??
    GLib.build_filenamev([PLAYER_DIR, 'stations.json']);

const loop = new GLib.MainLoop(null, false);
let player = null;
let unexport = null;
let quitting = false;

function quit() {
    if (quitting)
        return;
    quitting = true;
    unexport?.();
    player?.destroy();
    loop.quit();
}

try {
    player = new RadioPlayer(loadStations(stationsPath));
} catch (e) {
    log(e.message);
    System.exit(1);
}

Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME,
    Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
    connection => {
        unexport = exportInterfaces(connection, player, quit);
    },
    null,
    () => {
        log(`lost or could not own ${BUS_NAME}, exiting`);
        quit();
    });

// The extension keeps our stdin open; EOF means GNOME Shell went away.
if (watchStdin) {
    const stdin = new GioUnix.InputStream({fd: 0, close_fd: false});
    (async () => {
        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const bytes = await stdin.read_bytes_async(256, GLib.PRIORITY_LOW, null);
                if (bytes.get_size() === 0)
                    break;
            }
        } catch {}
        quit();
    })();
}

for (const signal of [2 /* SIGINT */, 15 /* SIGTERM */]) {
    // GLib 2.86 renamed signal_add_full() to signal_add().
    const signalAdd = GLib.check_version(2, 86, 0) === null
        ? GLibUnix.signal_add : GLibUnix.signal_add_full;
    signalAdd(GLib.PRIORITY_HIGH, signal, () => {
        quit();
        return GLib.SOURCE_REMOVE;
    });
}

loop.run();
