(function () {
    'use strict'

    const VERSION = '__PLUGIN_VERSION__'
    const BUILD_DATE = '__PLUGIN_BUILD_DATE__'
    const COMPONENT = 'tor_updater'
    const FOLLOW_KEY = 'torrent_follow'
    const FOLLOW_VERSION = 1
    const BOOTSTRAP_CACHE_KEY = 'tor_updater_bootstrap'
    const DEFAULT_CHECK_HOURS = 6
    const PROBE_TIMEOUT_MS = 18000
    const VIDEO_EXTENSIONS = new Set(['asf', 'wmv', 'divx', 'avi', 'mp4', 'm4v', 'mov', '3gp', '3g2', 'mkv', 'trp', 'tp', 'mts', 'mpg', 'mpeg', 'dat', 'vob', 'rm', 'rmvb', 'm2ts', 'ts'])

    const runtime = {
        pendingSelection: null,
        checking: new Set(),
        sessions: new Map(),
        candidates: new Map(),
        pendingCleanup: new Map(),
        activePlayerHash: null,
        listHash: null,
        bootstrapping: new Set(),
        notified: new Set(),
        recovery: null
    }

    function lampa() {
        return typeof window !== 'undefined' ? window.Lampa : null
    }

    function log(...args) {
        if (typeof console !== 'undefined' && console.log) console.log('[TorUpdater]', ...args)
    }

    function debug(...args) {
        const L = lampa()
        let on = false
        try { on = !!(L && L.Storage && L.Storage.field('tor_updater_debug')) } catch (_) {}
        if (on) log(...args)
    }

    function warn(...args) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[TorUpdater]', ...args)
    }

    function text(ru, en) {
        const L = lampa()
        let language = 'ru'
        try { language = L && L.Storage ? L.Storage.field('language') : 'ru' } catch (_) {}
        return language === 'ru' ? ru : en
    }

    function enabled() {
        const L = lampa()
        if (!L || !L.Storage) return false
        try { return L.Storage.field('tor_updater_enabled') !== false } catch (_) { return true }
    }

    function autoUpdateEnabled() {
        const L = lampa()
        if (!L || !L.Storage) return true
        try { return L.Storage.field('tor_updater_auto') !== false } catch (_) { return true }
    }

    function checkIntervalMs() {
        const L = lampa()
        let value = DEFAULT_CHECK_HOURS
        try { value = Number(L.Storage.field('tor_updater_interval') || DEFAULT_CHECK_HOURS) } catch (_) {}
        if (!Number.isFinite(value) || value < 1) value = DEFAULT_CHECK_HOURS
        return value * 60 * 60 * 1000
    }

    function isTruthy(value) {
        return value === true || value === 1 || value === '1' || value === 'true'
    }

    function shouldPersistByDefault() {
        const L = lampa()
        try { return isTruthy(L.Storage.get('torrserver_savedb', false)) } catch (_) { return false }
    }

    function safeJson(value, fallback) {
        if (!value) return fallback
        if (typeof value === 'object') return value
        try { return JSON.parse(value) } catch (_) { return fallback }
    }

    function clone(value) {
        try { return JSON.parse(JSON.stringify(value)) } catch (_) { return value }
    }

    function normalizedString(value) {
        return String(value || '').trim().toLowerCase()
    }

    function normalizeIdentityUrl(value) {
        if (!value) return ''
        const input = String(value).trim()
        if (!input) return ''

        try {
            const u = new URL(input)
            u.hash = ''
            u.hostname = u.hostname.toLowerCase()

            const sensitive = ['apikey', 'api_key', 'passkey', 'token', 'auth', 'authkey', 'key']
            sensitive.forEach((name) => u.searchParams.delete(name))

            const pairs = []
            u.searchParams.forEach((v, k) => pairs.push([k, v]))
            pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
            u.search = ''
            pairs.forEach(([k, v]) => u.searchParams.append(k, v))

            let out = u.toString()
            if (out.endsWith('/') && u.pathname !== '/') out = out.slice(0, -1)
            return out
        } catch (_) {
            return input.replace(/#.*$/, '').replace(/\/$/, '')
        }
    }

    // Two seeded FNV-1a passes. This is an identity token, not a security primitive.
    function stableHash(input) {
        const value = String(input || '')
        let h1 = 0x811c9dc5
        let h2 = 0x9e3779b9
        for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i)
            h1 ^= code
            h1 = Math.imul(h1, 0x01000193)
            h2 ^= code
            h2 = Math.imul(h2, 0x85ebca6b)
        }
        return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
    }

    function releaseIdentity(result) {
        if (!result) return null

        const trackerId = normalizedString(result.TrackerId || result.trackerId)
        const tracker = normalizedString(result.Tracker || result.tracker)
        const source = trackerId || tracker
        if (!source) return null

        const details = normalizeIdentityUrl(result.Details || result.details)
        const guid = normalizeIdentityUrl(result.Guid || result.guid)
        const identityUrl = details || guid
        if (!identityUrl) return null

        return {
            version: 1,
            key: stableHash(source + '|' + identityUrl),
            tracker_id: trackerId || '',
            tracker: tracker || '',
            via: details ? 'details' : 'guid'
        }
    }

    function base32ToHex(input) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
        let bits = ''
        let hex = ''
        const clean = String(input || '').toUpperCase().replace(/=+$/, '')

        for (const ch of clean) {
            const val = alphabet.indexOf(ch)
            if (val < 0) return ''
            bits += val.toString(2).padStart(5, '0')
        }

        for (let i = 0; i + 4 <= bits.length; i += 4) {
            hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
        }
        return hex.slice(0, 40)
    }

    function infoHashFromMagnet(uri) {
        if (!uri || !/^magnet:/i.test(String(uri))) return ''
        const match = String(uri).match(/[?&]xt=urn:btih:([^&]+)/i)
        if (!match) return ''
        let value = decodeURIComponent(match[1]).trim()
        if (/^[a-f0-9]{40}$/i.test(value)) return value.toLowerCase()
        if (/^[a-z2-7]{32}$/i.test(value)) return base32ToHex(value).toLowerCase()
        return ''
    }

    function resultInfoHash(result) {
        const direct = String((result && (result.InfoHash || result.infoHash)) || '').trim().toLowerCase()
        if (/^[a-f0-9]{40}$/i.test(direct)) return direct
        if (/^[a-z2-7]{32}$/i.test(direct)) return base32ToHex(direct).toLowerCase()
        return infoHashFromMagnet(result && (result.MagnetUri || result.magnetUri || result.Link || result.link || result.downloadUrl))
    }

    function resultLink(result) {
        return result && (result.MagnetUri || result.magnetUri || result.Link || result.link || result.downloadUrl) || ''
    }

    function sameRelease(follow, result) {
        if (!follow || !follow.release_key) return false
        const identity = releaseIdentity(result)
        return !!identity && identity.key === follow.release_key
    }

    function episodeKey(season, episode) {
        const s = Number(season)
        const e = Number(episode)
        if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < 1) return ''
        return `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`
    }

    function compareEpisodeMaps(oldMap, newMap) {
        const oldKeys = [...oldMap.keys()]
        const newKeys = [...newMap.keys()]
        if (!oldKeys.length || !newKeys.length) return 'unknown'

        const allOldPresent = oldKeys.every((key) => newMap.has(key))
        if (!allOldPresent) return 'incompatible'
        if (newKeys.length > oldKeys.length) return 'new_episodes'
        if (newKeys.length === oldKeys.length) return 'revision'
        return 'incompatible'
    }

    function isTv(movie) {
        return !!(movie && (movie.original_name || movie.name || movie.first_air_date || movie.number_of_seasons))
    }

    function parserQuery(movie) {
        const L = lampa()
        const title = movie.title || movie.name || ''
        const original = movie.original_title || movie.original_name || ''
        const year = String(movie.first_air_date || movie.release_date || '0000').slice(0, 4)
        const combinations = {
            df: original,
            df_year: `${original} ${year}`,
            df_lg: `${original} ${title}`,
            df_lg_year: `${original} ${title} ${year}`,
            lg: title,
            lg_year: `${title} ${year}`,
            lg_df: `${title} ${original}`,
            lg_df_year: `${title} ${original} ${year}`
        }
        let mode = 'df'
        try { mode = L.Storage.field('parse_lang') || 'df' } catch (_) {}
        return {
            one: title,
            two: original,
            text: String(combinations[mode] || combinations.df || title).trim()
        }
    }

    function hydrateMovie(movie) {
        const L = lampa()
        if (!movie || !movie.id || !isTv(movie)) return Promise.reject(new Error('Not a TV card'))
        if (Array.isArray(movie.genres)) return Promise.resolve(movie)

        const tmdb = L && L.Api && L.Api.sources && L.Api.sources.tmdb
        const source = tmdb && typeof tmdb.get === 'function' ? tmdb : (L && L.TMDB)
        if (!source || typeof source.get !== 'function') return Promise.reject(new Error('TMDB source is unavailable'))

        return new Promise((resolve, reject) => {
            source.get(`tv/${movie.id}`, {}, (fresh) => {
                if (!fresh || !Array.isArray(fresh.genres)) return reject(new Error('TMDB card has no genres'))
                resolve(Object.assign({}, fresh, movie, { genres: fresh.genres }))
            }, reject, { life: 60 * 24 })
        })
    }
